package dev.browsecraft.mod;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

public final class BackendClient implements BuildBackend {
    private static final long RECONNECT_BASE_DELAY_MS = 500;
    private static final long RECONNECT_MAX_DELAY_MS = 30_000;

    private final BackendEndpoints endpoints;
    private final HttpClient httpClient;
    private final Gson gson = new Gson();
    private final ScheduledExecutorService reconnectExecutor;
    private final AtomicInteger reconnectAttempts = new AtomicInteger();
    private final AtomicLong connectionGeneration = new AtomicLong();

    private volatile BuildBackendListener listener;
    private volatile WebSocket webSocket;
    private volatile boolean closed;
    private volatile boolean seenSuccessfulConnection;

    public BackendClient(BackendEndpoints endpoints, String mcVersion) {
        this.endpoints = Objects.requireNonNull(endpoints, "endpoints");
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .version(HttpClient.Version.HTTP_1_1)
                .build();
        this.reconnectExecutor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "browsecraft-backend-ws");
            thread.setDaemon(true);
            return thread;
        });
    }

    @Override
    public void connect(BuildBackendListener listener) {
        this.listener = listener;
        this.closed = false;
        long generation = this.connectionGeneration.incrementAndGet();
        openWebSocket(generation);
    }

    @Override
    public void submitChatMessage(
            String message,
            String clientId,
            BuildChatContext context,
            String sessionId
    ) throws IOException, InterruptedException {
        JsonObject requestBody = new JsonObject();
        requestBody.addProperty("clientId", clientId);
        requestBody.addProperty("message", message);
        requestBody.addProperty("worldId", context.worldId());
        requestBody.add("worldContext", context.worldContext());
        if (sessionId != null && !sessionId.isBlank()) {
            requestBody.addProperty("sessionId", sessionId);
        }
        postJson("/v1/chat", requestBody);
    }

    @Override
    public String createSession(String clientId, String worldId) throws IOException, InterruptedException {
        JsonObject requestBody = new JsonObject();
        requestBody.addProperty("clientId", clientId);
        requestBody.addProperty("worldId", worldId);
        HttpResponse<String> response = postJson("/v1/session/new", requestBody);
        JsonObject payload = JsonParser.parseString(response.body()).getAsJsonObject();
        return requiredString(payload, "sessionId");
    }

    @Override
    public List<SessionSummary> listSessions(String clientId, String worldId) throws IOException, InterruptedException {
        HttpResponse<String> response = getJson(
                "/v1/session/list",
                Map.of(
                        "clientId", clientId,
                        "worldId", worldId
                )
        );
        JsonObject payload = JsonParser.parseString(response.body()).getAsJsonObject();
        JsonArray sessions = payload.getAsJsonArray("sessions");
        List<SessionSummary> result = new ArrayList<>(sessions.size());
        for (JsonElement element : sessions) {
            JsonObject session = element.getAsJsonObject();
            result.add(new SessionSummary(
                    requiredString(session, "sessionId"),
                    requiredInt(session, "messageCount"),
                    requiredString(session, "createdAt"),
                    requiredString(session, "updatedAt")
            ));
        }
        return List.copyOf(result);
    }

    @Override
    public void switchSession(String clientId, String worldId, String sessionId) throws IOException, InterruptedException {
        JsonObject requestBody = new JsonObject();
        requestBody.addProperty("clientId", clientId);
        requestBody.addProperty("worldId", worldId);
        requestBody.addProperty("sessionId", sessionId);
        postJson("/v1/session/switch", requestBody);
    }

    @Override
    public void reportBuildResult(String jobId, BuildApplyResult result) {
        WebSocket socket = this.webSocket;
        if (socket == null) {
            throw new IllegalStateException("Cannot report build result without an active WebSocket");
        }

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "build.result");
        payload.addProperty("jobId", jobId);

        JsonObject body = new JsonObject();
        body.addProperty("success", result.success());
        if (result.error() != null) {
            body.addProperty("error", result.error());
        }
        body.addProperty("appliedCount", result.appliedCount());
        body.addProperty("fillCount", result.fillCount());
        body.addProperty("setblockCount", result.setblockCount());
        payload.add("payload", body);
        socket.sendText(gson.toJson(payload), true);
    }

    private HttpResponse<String> postJson(String endpoint, JsonObject requestBody) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(endpoints.baseUrl() + endpoint))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(requestBody)))
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IOException("Backend returned status " + response.statusCode() + ": " + response.body());
        }
        return response;
    }

    private HttpResponse<String> getJson(String endpoint, Map<String, String> queryParams) throws IOException, InterruptedException {
        StringBuilder uriBuilder = new StringBuilder(endpoints.baseUrl()).append(endpoint);
        if (!queryParams.isEmpty()) {
            uriBuilder.append("?");
            boolean first = true;
            for (Map.Entry<String, String> entry : queryParams.entrySet()) {
                if (!first) {
                    uriBuilder.append("&");
                }
                uriBuilder.append(URLEncoder.encode(entry.getKey(), StandardCharsets.UTF_8));
                uriBuilder.append("=");
                uriBuilder.append(URLEncoder.encode(entry.getValue(), StandardCharsets.UTF_8));
                first = false;
            }
        }

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(uriBuilder.toString()))
                .GET()
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IOException("Backend returned status " + response.statusCode() + ": " + response.body());
        }
        return response;
    }

    @Override
    public void close() {
        closed = true;
        WebSocket current = this.webSocket;
        if (current != null) {
            current.sendClose(WebSocket.NORMAL_CLOSURE, "closing");
        }
        reconnectExecutor.shutdownNow();
    }

    private void openWebSocket(long generation) {
        httpClient.newWebSocketBuilder()
                .buildAsync(URI.create(endpoints.wsUrl()), new SocketListener(generation))
                .whenComplete((socket, error) -> {
                    if (error != null) {
                        handleConnectionFailure(generation, error);
                        return;
                    }
                    this.webSocket = socket;
                    this.reconnectAttempts.set(0);
                    this.seenSuccessfulConnection = true;
                });
    }

    private void handleConnectionFailure(long generation, Throwable error) {
        if (closed || generation != connectionGeneration.get()) {
            return;
        }

        long delay = backoffDelayMillis(reconnectAttempts.getAndIncrement());
        BuildBackendListener currentListener = listener;
        if (currentListener != null && seenSuccessfulConnection) {
            currentListener.onError("", "WS_DISCONNECTED", error.getMessage());
        }

        reconnectExecutor.schedule(
                () -> {
                    if (closed || generation != connectionGeneration.get()) {
                        return;
                    }
                    openWebSocket(generation);
                },
                delay,
                TimeUnit.MILLISECONDS
        );
    }

    private long backoffDelayMillis(int attempts) {
        long exponent = 1L << Math.min(attempts, 16);
        return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * exponent);
    }

    private void handleIncomingMessage(String message) {
        JsonObject envelope = JsonParser.parseString(message).getAsJsonObject();
        String type = requiredString(envelope, "type");
        switch (type) {
            case "chat.response" -> handleChatResponse(envelope);
            case "chat.delta" -> handleChatDelta(envelope);
            case "build.apply" -> handleBuildApply(envelope);
            case "error" -> handleError(envelope);
            default -> {
            }
        }
    }

    private void handleChatResponse(JsonObject envelope) {
        BuildBackendListener currentListener = listener;
        if (currentListener == null) {
            return;
        }

        JsonObject payload = requiredObject(envelope, "payload");
        currentListener.onStatus(
                requiredString(payload, "jobId"),
                "chat.response",
                requiredString(payload, "message")
        );
    }

    private void handleChatDelta(JsonObject envelope) {
        BuildBackendListener currentListener = listener;
        if (currentListener == null) {
            return;
        }

        JsonObject payload = requiredObject(envelope, "payload");
        currentListener.onStatus(
                requiredString(payload, "jobId"),
                "chat.delta",
                requiredString(payload, "delta")
        );
    }

    private void handleBuildApply(JsonObject envelope) {
        BuildBackendListener currentListener = listener;
        if (currentListener == null) {
            return;
        }

        JsonObject payload = requiredObject(envelope, "payload");
        JsonArray placementsJson = payload.getAsJsonArray("placements");
        List<AbsoluteBuildPlacement> placements = new ArrayList<>(placementsJson.size());
        for (JsonElement element : placementsJson) {
            JsonObject placement = element.getAsJsonObject();
            placements.add(new AbsoluteBuildPlacement(
                    requiredInt(placement, "x"),
                    requiredInt(placement, "y"),
                    requiredInt(placement, "z"),
                    requiredString(placement, "blockId")
            ));
        }

        currentListener.onBuildApply(new BuildApplyRequest(
                requiredString(payload, "jobId"),
                requiredString(payload, "worldId"),
                requiredString(payload, "sessionId"),
                requiredInt(payload, "primitiveCount"),
                requiredDouble(payload, "executionTimeMs"),
                List.copyOf(placements)
        ));
    }

    private void handleError(JsonObject envelope) {
        BuildBackendListener currentListener = listener;
        if (currentListener == null) {
            return;
        }

        JsonObject payload = requiredObject(envelope, "payload");
        String jobId = payload.has("jobId") ? requiredString(payload, "jobId") : "";
        currentListener.onError(jobId, requiredString(payload, "code"), requiredString(payload, "message"));
    }

    private String requiredString(JsonObject object, String key) {
        JsonElement element = object.get(key);
        if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
            throw new IllegalArgumentException("Expected string field: " + key);
        }
        return element.getAsString();
    }

    private int requiredInt(JsonObject object, String key) {
        JsonElement element = object.get(key);
        if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isNumber()) {
            throw new IllegalArgumentException("Expected numeric field: " + key);
        }
        return element.getAsInt();
    }

    private double requiredDouble(JsonObject object, String key) {
        JsonElement element = object.get(key);
        if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isNumber()) {
            throw new IllegalArgumentException("Expected numeric field: " + key);
        }
        return element.getAsDouble();
    }

    private JsonObject requiredObject(JsonObject object, String key) {
        JsonElement element = object.get(key);
        if (element == null || !element.isJsonObject()) {
            throw new IllegalArgumentException("Expected object field: " + key);
        }
        return element.getAsJsonObject();
    }

    private final class SocketListener implements WebSocket.Listener {
        private final long generation;
        private final StringBuilder pendingText = new StringBuilder();

        private SocketListener(long generation) {
            this.generation = generation;
        }

        @Override
        public void onOpen(WebSocket webSocket) {
            WebSocket.Listener.super.onOpen(webSocket);
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            pendingText.append(data);
            if (last) {
                String message = pendingText.toString();
                pendingText.setLength(0);
                handleIncomingMessage(message);
            }
            webSocket.request(1);
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            handleConnectionFailure(generation, new IOException("WebSocket closed: " + statusCode + " " + reason));
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            handleConnectionFailure(generation, error);
        }
    }
}
