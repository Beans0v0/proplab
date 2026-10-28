import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * PropLab host. Zero dependencies: JDK only.
 *
 *   java Server.java [port]
 *
 * Two jobs:
 *   1. Serve ./public as a static site.
 *   2. /api/data?key=...  -> fetch nflverse open data, cache it on disk in ./.cache, hand it to the browser.
 *
 * The proxy exists because the browser cannot fetch these CSVs directly (no CORS headers on
 * GitHub release assets) and because the raw files are large: caching them locally means the
 * engine only pays the download cost once per season.
 */
public class Server {

    static final Path ROOT = Paths.get("").toAbsolutePath();
    static final Path PUBLIC = ROOT.resolve("public");
    static final Path CACHE = ROOT.resolve(".cache");

    /** Only these keys can be proxied. No arbitrary URLs => no SSRF. */
    static Map<String, String> endpoints() {
        String base = "https://github.com/nflverse/nflverse-data/releases/download";
        Map<String, String> m = new LinkedHashMap<>();
        m.put("games", base + "/schedules/games.csv");
        for (int season : new int[]{2026, 2025, 2024}) {
            m.put("player_" + season, base + "/stats_player/stats_player_week_" + season + ".csv");
            m.put("team_" + season, base + "/stats_team/stats_team_week_" + season + ".csv");
            m.put("inj_" + season, base + "/injuries/injuries_" + season + ".csv");
            m.put("snaps_" + season, base + "/snap_counts/snap_counts_" + season + ".csv");
        }
        return m;
    }

    /**
     * NBA keys. These are validated by pattern and assembled from numbers only, so the
     * proxy still cannot be pointed at an arbitrary URL - the SSRF guarantee is the same
     * as the fixed nflverse map above. Source is ESPN's public (undocumented) JSON.
     */
    static String nbaUrl(String key) {
        if (key.equals("injuries")) return "https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/injuries";
        if (key.equals("teams")) return "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams";
        if (key.matches("scoreboard:\\d{8}(-\\d{8})?"))
            return "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates="
                    + key.substring("scoreboard:".length());
        if (key.matches("roster:\\d{1,6}"))
            return "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/"
                    + key.substring("roster:".length()) + "/roster";
        if (key.matches("teamschedule:\\d{1,6}"))
            return "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/"
                    + key.substring("teamschedule:".length()) + "/schedule";
        if (key.matches("teamstats:\\d{1,6}:\\d{4}")) {
            String[] p = key.split(":");
            return "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/" + p[2]
                    + "/types/2/teams/" + p[1] + "/statistics";
        }
        if (key.matches("player:\\d{1,9}:\\d{4}")) {
            String[] p = key.split(":");
            return "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/" + p[1]
                    + "/gamelog?season=" + p[2];
        }
        return null;
    }

    /** How long a cached response stays fresh. Live feeds expire; player history does not. */
    static long ttlSeconds(String key) {
        if (key.startsWith("scoreboard")) return 600;
        if (key.startsWith("injuries")) return 900;
        if (key.startsWith("roster")) return 21600;
        if (key.startsWith("teamstats")) return 3600;
        return 86400;
    }

    static final HttpClient HTTP = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.ALWAYS)
            .connectTimeout(Duration.ofSeconds(30))
            .build();

    public static void main(String[] args) throws IOException {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 8787;
        Files.createDirectories(CACHE);
        Files.createDirectories(PUBLIC);

        Map<String, String> endpoints = endpoints();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.setExecutor(Executors.newFixedThreadPool(8));

        server.createContext("/api/health", ex -> {
            String body = "{\"ok\":true,\"cached\":" + CACHE.toFile().listFiles().length + "}";
            send(ex, 200, "application/json", body.getBytes(StandardCharsets.UTF_8));
        });

        server.createContext("/api/data", ex -> {
            String key = query(ex.getRequestURI()).get("key");
            String url = key == null ? null : endpoints.get(key);
            if (url == null) {
                send(ex, 400, "application/json", ("{\"error\":\"unknown key: " + key + "\"}").getBytes(StandardCharsets.UTF_8));
                return;
            }
            Path cached = CACHE.resolve(key + ".csv");
            try {
                if (!Files.exists(cached) || Files.size(cached) < 1024) {
                    System.out.println("[data] downloading " + key + " ...");
                    HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                            .timeout(Duration.ofMinutes(5))
                            // nflverse is a public data repo; no credentials, no cookies.
                            .header("User-Agent", "ProPLab-local/1.0 (personal analysis)")
                            .GET().build();
                    Path tmp = CACHE.resolve(key + ".csv.part");
                    HttpResponse<Path> res = HTTP.send(req, HttpResponse.BodyHandlers.ofFile(tmp));
                    if (res.statusCode() != 200) {
                        Files.deleteIfExists(tmp);
                        send(ex, 502, "application/json",
                                ("{\"error\":\"upstream status " + res.statusCode() + "\"}").getBytes(StandardCharsets.UTF_8));
                        return;
                    }
                    Files.move(tmp, cached, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                    System.out.println("[data] cached " + key + " (" + Files.size(cached) + " bytes)");
                }
                byte[] bytes = Files.readAllBytes(cached);
                ex.getResponseHeaders().add("Cache-Control", "public, max-age=86400");
                send(ex, 200, "text/csv; charset=utf-8", bytes);
            } catch (Exception e) {
                System.out.println("[data] FAILED " + key + ": " + e);
                send(ex, 500, "application/json",
                        ("{\"error\":" + jsonString(String.valueOf(e.getMessage())) + "}").getBytes(StandardCharsets.UTF_8));
            }
        });

        server.createContext("/api/nba", ex -> {
            String key = query(ex.getRequestURI()).get("key");
            String url = key == null ? null : nbaUrl(key);
            if (url == null) {
                send(ex, 400, "application/json",
                        ("{\"error\":\"unknown nba key: " + key + "\"}").getBytes(StandardCharsets.UTF_8));
                return;
            }
            String slug = key.replace(':', '_');
            Path cached = CACHE.resolve("nba_" + slug + ".json");
            try {
                boolean stale = !Files.exists(cached) || Files.size(cached) < 64
                        || System.currentTimeMillis() - Files.getLastModifiedTime(cached).toMillis()
                           > ttlSeconds(key) * 1000L;
                if (stale) {
                    System.out.println("[nba] fetching " + key + " ...");
                    HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                            .timeout(Duration.ofMinutes(2))
                            .header("User-Agent", "ProPLab-local/1.0 (personal analysis)")
                            .GET().build();
                    Path tmp = CACHE.resolve("nba_" + slug + ".json.part");
                    HttpResponse<Path> res = HTTP.send(req, HttpResponse.BodyHandlers.ofFile(tmp));
                    if (res.statusCode() != 200) {
                        Files.deleteIfExists(tmp);
                        send(ex, 502, "application/json",
                                ("{\"error\":\"upstream status " + res.statusCode() + "\"}").getBytes(StandardCharsets.UTF_8));
                        return;
                    }
                    Files.move(tmp, cached, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
                byte[] bytes = Files.readAllBytes(cached);
                ex.getResponseHeaders().add("Cache-Control", "no-store");
                send(ex, 200, "application/json; charset=utf-8", bytes);
            } catch (Exception e) {
                System.out.println("[nba] FAILED " + key + ": " + e);
                send(ex, 500, "application/json",
                        ("{\"error\":" + jsonString(String.valueOf(e.getMessage())) + "}").getBytes(StandardCharsets.UTF_8));
            }
        });

        server.createContext("/", Server::serveStatic);

        server.start();
        System.out.println("PropLab listening on http://127.0.0.1:" + port);
        System.out.println("static root: " + PUBLIC);
        System.out.println("data cache : " + CACHE + " (" + endpoints.size() + " nflverse + espn nba datasets)");
    }

    static void serveStatic(HttpExchange ex) throws IOException {
        String raw = ex.getRequestURI().getPath();
        String rel = raw.equals("/") ? "index.html" : raw.replaceFirst("^/+", "");
        Path file = PUBLIC.resolve(rel).normalize();
        if (!file.startsWith(PUBLIC)) {                       // no traversal
            send(ex, 403, "text/plain", "forbidden".getBytes(StandardCharsets.UTF_8));
            return;
        }
        if (!Files.isRegularFile(file)) {
            byte[] body = ("not found: " + rel).getBytes(StandardCharsets.UTF_8);
            send(ex, 404, "text/plain; charset=utf-8", body);
            return;
        }
        if (ex.getRequestMethod().equals("HEAD")) {           // used by probes
            ex.getResponseHeaders().add("Content-Type", contentType(file));
            ex.sendResponseHeaders(200, -1);
            ex.close();
            return;
        }
        send(ex, 200, contentType(file), Files.readAllBytes(file));
    }

    static String contentType(Path p) {
        String n = p.getFileName().toString().toLowerCase();
        if (n.endsWith(".html")) return "text/html; charset=utf-8";
        if (n.endsWith(".css")) return "text/css; charset=utf-8";
        if (n.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (n.endsWith(".json")) return "application/json; charset=utf-8";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".csv")) return "text/csv; charset=utf-8";
        return "application/octet-stream";
    }

    static void send(HttpExchange ex, int status, String type, byte[] body) throws IOException {
        ex.getResponseHeaders().add("Content-Type", type);
        ex.getResponseHeaders().add("X-Content-Type-Options", "nosniff");
        ex.sendResponseHeaders(status, body.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(body);
        }
    }

    static Map<String, String> query(URI uri) {
        Map<String, String> q = new LinkedHashMap<>();
        String s = uri.getRawQuery();
        if (s == null) return q;
        for (String pair : s.split("&")) {
            int i = pair.indexOf('=');
            if (i < 0) continue;
            q.put(urlDecode(pair.substring(0, i)), urlDecode(pair.substring(i + 1)));
        }
        return q;
    }

    static String urlDecode(String s) {
        return java.net.URLDecoder.decode(s, StandardCharsets.UTF_8);
    }

    static String jsonString(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> {
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
                }
            }
        }
        return b.append('"').toString();
    }
}
