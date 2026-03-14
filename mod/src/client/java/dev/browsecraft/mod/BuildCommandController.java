package dev.browsecraft.mod;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.function.Consumer;
import java.util.function.Supplier;

public final class BuildCommandController implements BuildBackendListener {
    public interface ChatEventListener {
        void onUserMessage(String message);

        void onAssistantMessage(String message);

        void onStatus(String status);
    }

    public interface BuildApplyHandler {
        void onBuildApply(BuildApplyRequest request);
    }

    private final String clientId;
    private final BuildBackend backend;
    private final Executor mainExecutor;
    private final Executor workerExecutor;
    private final Consumer<String> statusSink;
    private final Supplier<String> worldIdSupplier;
    private final Supplier<BuildChatContext> chatContextSupplier;
    private final ChatEventListener chatEvents;
    private final BuildApplyHandler buildApplyHandler;
    private String activeSessionId;

    public BuildCommandController(
            String clientId,
            BuildBackend backend,
            Executor mainExecutor,
            Executor workerExecutor,
            Consumer<String> statusSink,
            Supplier<String> worldIdSupplier,
            Supplier<BuildChatContext> chatContextSupplier,
            ChatEventListener chatEvents,
            BuildApplyHandler buildApplyHandler
    ) {
        this.clientId = clientId;
        this.backend = backend;
        this.mainExecutor = mainExecutor;
        this.workerExecutor = workerExecutor;
        this.statusSink = statusSink;
        this.worldIdSupplier = worldIdSupplier;
        this.chatContextSupplier = chatContextSupplier;
        this.chatEvents = chatEvents;
        this.buildApplyHandler = buildApplyHandler;
        this.backend.connect(this);
    }

    public void submitChat(String message) {
        submitChat(message, null);
    }

    public void submitChat(String message, String explicitSessionId) {
        BuildChatContext context;
        try {
            context = chatContextSupplier.get();
        } catch (Exception error) {
            statusSink.accept("chat submit failed: " + error.getMessage());
            return;
        }

        String sessionIdForRequest = explicitSessionId;
        if (sessionIdForRequest == null || sessionIdForRequest.isBlank()) {
            sessionIdForRequest = activeSessionId;
        }
        String finalSessionIdForRequest = sessionIdForRequest;

        statusSink.accept("thinking...");
        mainExecutor.execute(() -> chatEvents.onUserMessage(message));
        workerExecutor.execute(() -> {
            try {
                backend.submitChatMessage(message, clientId, context, finalSessionIdForRequest);
            } catch (Exception error) {
                mainExecutor.execute(() -> statusSink.accept("chat submit failed: " + error.getMessage()));
            }
        });
    }

    public void createSession() {
        String worldId;
        try {
            worldId = worldIdSupplier.get();
        } catch (Exception error) {
            statusSink.accept("session new failed: " + error.getMessage());
            return;
        }

        statusSink.accept("creating session...");
        workerExecutor.execute(() -> {
            try {
                String sessionId = backend.createSession(clientId, worldId);
                activeSessionId = sessionId;
                mainExecutor.execute(() -> statusSink.accept("active session: " + sessionId));
            } catch (Exception error) {
                mainExecutor.execute(() -> statusSink.accept("session new failed: " + error.getMessage()));
            }
        });
    }

    public void listSessions() {
        String worldId;
        try {
            worldId = worldIdSupplier.get();
        } catch (Exception error) {
            statusSink.accept("session list failed: " + error.getMessage());
            return;
        }

        statusSink.accept("loading sessions...");
        workerExecutor.execute(() -> {
            try {
                List<SessionSummary> sessions = backend.listSessions(clientId, worldId);
                String message;
                if (sessions.isEmpty()) {
                    message = "No sessions";
                } else {
                    List<String> rendered = new ArrayList<>(sessions.size());
                    for (SessionSummary session : sessions) {
                        if (session.sessionId().equals(activeSessionId)) {
                            rendered.add("*" + session.sessionId());
                        } else {
                            rendered.add(session.sessionId());
                        }
                    }
                    message = String.join(", ", rendered);
                }
                String statusMessage = message;
                mainExecutor.execute(() -> statusSink.accept(statusMessage));
            } catch (Exception error) {
                mainExecutor.execute(() -> statusSink.accept("session list failed: " + error.getMessage()));
            }
        });
    }

    public void switchSession(String sessionId) {
        String worldId;
        try {
            worldId = worldIdSupplier.get();
        } catch (Exception error) {
            statusSink.accept("session switch failed: " + error.getMessage());
            return;
        }

        statusSink.accept("switching session...");
        workerExecutor.execute(() -> {
            try {
                backend.switchSession(clientId, worldId, sessionId);
                activeSessionId = sessionId;
                mainExecutor.execute(() -> statusSink.accept("active session: " + sessionId));
            } catch (Exception error) {
                mainExecutor.execute(() -> statusSink.accept("session switch failed: " + error.getMessage()));
            }
        });
    }

    @Override
    public void onStatus(String jobId, String stage, String message) {
        mainExecutor.execute(() -> {
            switch (stage) {
                case "chat.delta" -> {
                    chatEvents.onStatus(message);
                    statusSink.accept(message);
                }
                case "chat.response" -> {
                    chatEvents.onAssistantMessage(message);
                    statusSink.accept("chat: " + message);
                }
                default -> statusSink.accept(stage + ": " + message);
            }
        });
    }

    @Override
    public void onBuildApply(BuildApplyRequest request) {
        mainExecutor.execute(() -> {
            statusSink.accept("applying build...");
            buildApplyHandler.onBuildApply(request);
        });
    }

    @Override
    public void onError(String jobId, String code, String message) {
        mainExecutor.execute(() -> statusSink.accept(code + ": " + message));
    }
}
