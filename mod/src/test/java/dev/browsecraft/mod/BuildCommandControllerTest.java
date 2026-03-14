package dev.browsecraft.mod;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class BuildCommandControllerTest {
    private static final BuildCommandController.ChatEventListener NO_OP_CHAT_EVENTS = new BuildCommandController.ChatEventListener() {
        @Override
        public void onUserMessage(String message) {
        }

        @Override
        public void onAssistantMessage(String message) {
        }

        @Override
        public void onStatus(String status) {
        }
    };

    @Test
    void chatUsesActiveSessionCreatedBySessionNew() {
        FakeBackend backend = new FakeBackend();
        List<String> statuses = new ArrayList<>();
        BuildCommandController controller = new BuildCommandController(
                "client-1",
                backend,
                directExecutor(),
                directExecutor(),
                statuses::add,
                () -> "world-1",
                () -> chatContext("world-1"),
                NO_OP_CHAT_EVENTS,
                request -> {
                }
        );

        controller.createSession();
        controller.submitChat("hello");

        assertEquals("world-1", backend.lastChatWorldId);
        assertEquals("session-1", backend.lastChatSessionId);
        assertEquals("hello", backend.lastChatMessage);
        assertTrue(statuses.contains("active session: session-1"));
    }

    @Test
    void explicitChatSessionOverridesActiveSession() {
        FakeBackend backend = new FakeBackend();
        BuildCommandController controller = new BuildCommandController(
                "client-2",
                backend,
                directExecutor(),
                directExecutor(),
                message -> {
                },
                () -> "world-2",
                () -> chatContext("world-2"),
                NO_OP_CHAT_EVENTS,
                request -> {
                }
        );

        controller.createSession();
        controller.submitChat("hello", "session-explicit");

        assertEquals("world-2", backend.lastChatWorldId);
        assertEquals("session-explicit", backend.lastChatSessionId);
    }

    @Test
    void sessionSwitchChangesActiveSession() {
        FakeBackend backend = new FakeBackend();
        backend.sessions = List.of(
                new SessionSummary("session-a", 2, "2026-03-13T00:00:00Z", "2026-03-13T00:00:00Z"),
                new SessionSummary("session-b", 2, "2026-03-13T00:00:01Z", "2026-03-13T00:00:01Z")
        );
        BuildCommandController controller = new BuildCommandController(
                "client-3",
                backend,
                directExecutor(),
                directExecutor(),
                message -> {
                },
                () -> "world-3",
                () -> chatContext("world-3"),
                NO_OP_CHAT_EVENTS,
                request -> {
                }
        );

        controller.switchSession("session-b");
        controller.submitChat("hello");

        assertEquals("client-3", backend.lastSwitchClientId);
        assertEquals("world-3", backend.lastSwitchWorldId);
        assertEquals("session-b", backend.lastSwitchedSessionId);
        assertEquals("session-b", backend.lastChatSessionId);
    }

    @Test
    void sessionListMarksActiveSession() {
        FakeBackend backend = new FakeBackend();
        backend.sessions = List.of(
                new SessionSummary("session-a", 2, "2026-03-13T00:00:00Z", "2026-03-13T00:00:00Z"),
                new SessionSummary("session-b", 2, "2026-03-13T00:00:01Z", "2026-03-13T00:00:01Z")
        );
        List<String> statuses = new ArrayList<>();
        BuildCommandController controller = new BuildCommandController(
                "client-4",
                backend,
                directExecutor(),
                directExecutor(),
                statuses::add,
                () -> "world-4",
                () -> chatContext("world-4"),
                NO_OP_CHAT_EVENTS,
                request -> {
                }
        );

        controller.switchSession("session-a");
        controller.listSessions();

        assertTrue(statuses.contains("*session-a, session-b"));
    }

    @Test
    void backendStatusStagesReachChatEventListener() {
        FakeBackend backend = new FakeBackend();
        RecordingChatEvents chatEvents = new RecordingChatEvents();
        List<String> statuses = new ArrayList<>();
        BuildCommandController controller = new BuildCommandController(
                "client-events",
                backend,
                directExecutor(),
                directExecutor(),
                statuses::add,
                () -> "world-events",
                () -> chatContext("world-events"),
                chatEvents,
                request -> {
                }
        );

        controller.onStatus("job-1", "chat.delta", "Applying 5 block changes.");
        controller.onStatus("job-1", "chat.response", "Applied 5 block changes.");

        assertEquals(List.of("Applying 5 block changes."), chatEvents.statuses);
        assertEquals(List.of("Applied 5 block changes."), chatEvents.assistantMessages);
        assertTrue(statuses.contains("chat: Applied 5 block changes."));
        assertTrue(statuses.contains("Applying 5 block changes."));
    }

    @Test
    void buildApplyRoutesToHandler() {
        FakeBackend backend = new FakeBackend();
        List<BuildApplyRequest> applied = new ArrayList<>();
        BuildCommandController controller = new BuildCommandController(
                "client-build",
                backend,
                directExecutor(),
                directExecutor(),
                message -> {
                },
                () -> "world-build",
                () -> chatContext("world-build"),
                NO_OP_CHAT_EVENTS,
                applied::add
        );

        controller.onBuildApply(new BuildApplyRequest(
                "job-1",
                "world-build",
                "session-1",
                2,
                1.5,
                List.of(new AbsoluteBuildPlacement(1, 64, 1, "minecraft:stone"))
        ));

        assertEquals(1, applied.size());
        assertEquals("job-1", applied.getFirst().jobId());
    }

    private Executor directExecutor() {
        return Runnable::run;
    }

    private BuildChatContext chatContext(String worldId) {
        JsonObject worldContext = new JsonObject();
        JsonObject player = new JsonObject();
        player.addProperty("x", 0);
        player.addProperty("y", 64);
        player.addProperty("z", 0);
        player.addProperty("facing", "north");
        player.addProperty("dimension", "minecraft:overworld");
        worldContext.add("player", player);
        worldContext.add("blocks", new JsonObject());
        return new BuildChatContext(worldId, worldContext);
    }

    private static final class FakeBackend implements BuildBackend {
        private List<SessionSummary> sessions = List.of(new SessionSummary("session-1", 0, "2026-03-13T00:00:00Z", "2026-03-13T00:00:00Z"));
        private String lastChatMessage;
        private String lastChatWorldId;
        private String lastChatSessionId;
        private String lastSwitchClientId;
        private String lastSwitchWorldId;
        private String lastSwitchedSessionId;

        @Override
        public void connect(BuildBackendListener listener) {
        }

        @Override
        public void submitChatMessage(String message, String clientId, BuildChatContext context, String sessionId) {
            this.lastChatMessage = message;
            this.lastChatWorldId = context.worldId();
            this.lastChatSessionId = sessionId;
        }

        @Override
        public String createSession(String clientId, String worldId) {
            return "session-1";
        }

        @Override
        public List<SessionSummary> listSessions(String clientId, String worldId) {
            return sessions;
        }

        @Override
        public void switchSession(String clientId, String worldId, String sessionId) {
            this.lastSwitchClientId = clientId;
            this.lastSwitchWorldId = worldId;
            this.lastSwitchedSessionId = sessionId;
        }

        @Override
        public void reportBuildResult(String jobId, BuildApplyResult result) {
        }

        @Override
        public void close() {
        }
    }

    private static final class RecordingChatEvents implements BuildCommandController.ChatEventListener {
        private final List<String> assistantMessages = new ArrayList<>();
        private final List<String> statuses = new ArrayList<>();

        @Override
        public void onUserMessage(String message) {
        }

        @Override
        public void onAssistantMessage(String message) {
            assistantMessages.add(message);
        }

        @Override
        public void onStatus(String status) {
            statuses.add(status);
        }
    }
}
