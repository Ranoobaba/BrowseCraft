package dev.browsecraft.mod;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.fabricmc.fabric.api.client.rendering.v1.hud.VanillaHudElements;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.client.util.ScreenshotRecorder;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.registry.Registries;
import net.minecraft.text.OrderedText;
import net.minecraft.text.Text;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import org.lwjgl.glfw.GLFW;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

import static net.fabricmc.fabric.api.client.command.v2.ClientCommandManager.argument;
import static net.fabricmc.fabric.api.client.command.v2.ClientCommandManager.literal;

public final class BrowseCraftClient implements ClientModInitializer {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final int SNAPSHOT_RADIUS = 24;
    private static final int HUD_TEST_SETTLE_TICKS = 4;
    private static final int HUD_MARGIN = 10;
    private static final int HUD_PANEL_WIDTH = 340;
    private static final int HUD_PANEL_HEIGHT = 210;
    private static final int HUD_HEADER_HEIGHT = 20;
    private static final int HUD_INPUT_HEIGHT = 24;
    private static final int HUD_INSET = 7;
    private static final Identifier HUD_LAYER_ID = Identifier.of("browsecraft", "hud_panel");
    private static final String HUD_TEST_ON_STARTUP_PROPERTY = "browsecraft.hudTestOnStartup";
    private static final String HUD_TEST_EXIT_ON_COMPLETE_PROPERTY = "browsecraft.hudTestExitOnComplete";
    private static volatile BrowseCraftClient instance;

    public static volatile Path latestHudTestJsonPath;

    private BuildCommandController commandController;
    private BuildBackend backend;
    private ExecutorService workerExecutor;
    private String clientId;
    private final WorldIdResolver worldIdResolver = new WorldIdResolver();
    private List<AbsoluteBuildPlacement> undoPlacements = List.of();
    private boolean hasUndoState;

    private KeyBinding openChatKey;
    private KeyBinding.Category keyCategory;

    private volatile String latestStatusMessage = "";
    private final HudChatState hudChatState = new HudChatState();
    private final List<ChatPanelScreen.ChatMessage> chatHistory = new ArrayList<>();
    private String activeStatus = "";
    private boolean assistantPending;
    private HudCaptureSession hudCaptureSession;
    private HudRenderSnapshot latestHudRenderSnapshot = new HudRenderSnapshot(
            HudChatState.Mode.HIDDEN,
            false,
            0,
            0,
            "",
            "",
            false,
            null,
            null,
            List.of(),
            0,
            "",
            0,
            0
    );
    private boolean hudTestStartupTriggered;

    @Override
    public void onInitializeClient() {
        instance = this;
        this.clientId = UUID.randomUUID().toString();
        this.backend = new BackendClient(BackendEndpoints.localhost(clientId), "1.21.11");
        this.workerExecutor = Executors.newVirtualThreadPerTaskExecutor();

        Executor mainExecutor = runnable -> MinecraftClient.getInstance().execute(runnable);
        Consumer<String> statusSink = message -> {
            latestStatusMessage = message;
            MinecraftClient client = MinecraftClient.getInstance();
            if (client.player != null) {
                client.player.sendMessage(Text.literal(message), true);
            }
        };

        this.commandController = new BuildCommandController(
                clientId,
                backend,
                mainExecutor,
                workerExecutor,
                statusSink,
                () -> worldIdResolver.resolve(MinecraftClient.getInstance()),
                this::captureBuildChatContext,
                new BuildCommandController.ChatEventListener() {
                    @Override
                    public void onUserMessage(String message) {
                        handleChatUserMessage(message);
                    }

                    @Override
                    public void onAssistantMessage(String message) {
                        handleChatAssistantMessage(message);
                    }

                    @Override
                    public void onStatus(String status) {
                        handleChatStatus(status);
                    }
                },
                this::handleBuildApply
        );

        registerKeyBindings();
        registerCommands();
        registerClientTick();
        registerHudRenderer();
    }

    public static Path latestHudTestJsonPath() {
        return latestHudTestJsonPath;
    }

    public static String latestStatusMessage() {
        BrowseCraftClient current = instance;
        return current == null ? "" : current.latestStatusMessage;
    }

    public static void onHudTestCommand() {
        BrowseCraftClient current = instance;
        if (current == null) {
            throw new IllegalStateException("BrowseCraft client is not initialized");
        }
        current.runHudTestCommand(MinecraftClient.getInstance());
    }

    private void registerKeyBindings() {
        this.keyCategory = KeyBinding.Category.create(Identifier.of("browsecraft", "controls"));
        this.openChatKey = KeyBindingHelper.registerKeyBinding(new KeyBinding(
                "key.browsecraft.open_chat",
                InputUtil.Type.KEYSYM,
                GLFW.GLFW_KEY_B,
                keyCategory
        ));
    }

    private void registerCommands() {
        ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> {
            dispatcher.register(literal("chat")
                    .executes(context -> {
                        openChatPanel(MinecraftClient.getInstance(), "");
                        return 1;
                    })
                    .then(argument("message", StringArgumentType.greedyString())
                            .executes(context -> {
                                String message = StringArgumentType.getString(context, "message");
                                openChatPanel(MinecraftClient.getInstance(), message);
                                return 1;
                            })));

            dispatcher.register(literal("session")
                    .then(literal("new")
                            .executes(context -> {
                                commandController.createSession();
                                return 1;
                            }))
                    .then(literal("list")
                            .executes(context -> {
                                commandController.listSessions();
                                return 1;
                            }))
                    .then(literal("switch")
                            .then(argument("id", StringArgumentType.word())
                                    .executes(context -> {
                                        String sessionId = StringArgumentType.getString(context, "id");
                                        commandController.switchSession(sessionId);
                                        return 1;
                                    }))));

            dispatcher.register(literal("hud-test")
                    .executes(context -> {
                        runHudTestCommand(MinecraftClient.getInstance());
                        return 1;
                    }));
        });
    }

    private void registerClientTick() {
        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            while (openChatKey.wasPressed()) {
                if (client.currentScreen instanceof ChatPanelScreen) {
                    client.setScreen(null);
                } else {
                    openChatPanel(client, "");
                }
            }

            if (!hudTestStartupTriggered && Boolean.getBoolean(HUD_TEST_ON_STARTUP_PROPERTY)) {
                hudTestStartupTriggered = true;
                runHudTestCommand(client);
            }

            if (hudCaptureSession != null) {
                tickHudCaptureSession(client);
            }
        });
    }

    private void registerHudRenderer() {
        HudElementRegistry.attachElementBefore(
                VanillaHudElements.CHAT,
                HUD_LAYER_ID,
                (drawContext, tickCounter) -> renderHud(drawContext)
        );
    }

    private void openChatPanel(MinecraftClient client, String prefill) {
        client.setScreen(new ChatPanelScreen(
                this::submitChatFromPanel,
                this::chatHistorySnapshot,
                this::hudStatusLabel,
                prefill
        ));
    }

    private void submitChatFromPanel(String message) {
        commandController.submitChat(message);
    }

    private List<ChatPanelScreen.ChatMessage> chatHistorySnapshot() {
        return List.copyOf(chatHistory);
    }

    private String hudStatusLabel() {
        if (activeStatus.isBlank()) {
            if (assistantPending) {
                return "thinking...";
            }
            return "";
        }
        return activeStatus;
    }

    private HudRenderSnapshot buildHudRenderSnapshot(MinecraftClient client) {
        int screenWidth = client.getWindow().getScaledWidth();
        int screenHeight = client.getWindow().getScaledHeight();
        String status = hudStatusLabel();
        String header = status.isBlank() ? "BrowseCraft" : status;
        if (client.options.hudHidden || hudChatState.mode() == HudChatState.Mode.HIDDEN) {
            return new HudRenderSnapshot(
                    hudChatState.mode(),
                    false,
                    screenWidth,
                    screenHeight,
                    header,
                    activeStatus,
                    assistantPending,
                    null,
                    null,
                    List.of(),
                    0,
                    hudChatState.inputText(),
                    hudChatState.cursor(),
                    0
            );
        }

        int panelWidth = Math.min(HUD_PANEL_WIDTH, screenWidth - (HUD_MARGIN * 2));
        int inputOffset = hudChatState.mode() == HudChatState.Mode.INPUT ? HUD_INPUT_HEIGHT + HUD_MARGIN : 0;
        int maxPanelHeight = screenHeight - (HUD_MARGIN * 2) - inputOffset;
        int panelHeight = Math.min(HUD_PANEL_HEIGHT, Math.max(80, maxPanelHeight));
        int left = screenWidth - panelWidth - HUD_MARGIN;
        int top = HUD_MARGIN;
        int right = left + panelWidth;
        int bottom = top + panelHeight;
        int textWidth = panelWidth - (HUD_INSET * 2);
        int messagesTop = top + HUD_HEADER_HEIGHT;
        int messagesBottom = bottom - HUD_INSET;
        List<RenderedLine> lines = buildRenderedLines(chatHistory, client.textRenderer, textWidth);
        int lineHeight = client.textRenderer.fontHeight + 2;
        int maxVisible = Math.max(1, (messagesBottom - messagesTop) / lineHeight);
        int visibleStartIndex = Math.max(0, lines.size() - maxVisible);
        HudBounds panelBounds = new HudBounds(left, top, right, bottom);
        HudBounds inputBounds = null;
        int cursorX = 0;

        if (hudChatState.mode() == HudChatState.Mode.INPUT) {
            inputBounds = inputBarBounds(screenWidth, screenHeight);
            int cursorIndex = Math.max(0, Math.min(hudChatState.cursor(), hudChatState.inputText().length()));
            cursorX = inputBounds.left() + HUD_INSET
                    + client.textRenderer.getWidth("> " + hudChatState.inputText().substring(0, cursorIndex));
        }

        return new HudRenderSnapshot(
                hudChatState.mode(),
                true,
                screenWidth,
                screenHeight,
                header,
                activeStatus,
                assistantPending,
                panelBounds,
                inputBounds,
                lines,
                visibleStartIndex,
                hudChatState.inputText(),
                hudChatState.cursor(),
                cursorX
        );
    }

    private void renderHud(DrawContext context) {
        MinecraftClient client = MinecraftClient.getInstance();
        HudRenderSnapshot snapshot = buildHudRenderSnapshot(client);
        latestHudRenderSnapshot = snapshot;
        if (!snapshot.visible()) {
            return;
        }

        HudBounds panelBounds = snapshot.panelBounds();
        int lineHeight = client.textRenderer.fontHeight + 2;
        int messagesTop = panelBounds.top() + HUD_HEADER_HEIGHT;
        int y = messagesTop;
        context.fill(panelBounds.left(), panelBounds.top(), panelBounds.right(), panelBounds.bottom(), 0xB0101010);
        context.drawText(client.textRenderer, snapshot.header(), panelBounds.left() + HUD_INSET, panelBounds.top() + 6, 0xFFE8E8A0, false);

        for (int index = snapshot.visibleStartIndex(); index < snapshot.wrappedLines().size(); index++) {
            RenderedLine line = snapshot.wrappedLines().get(index);
            context.drawText(client.textRenderer, line.orderedText(), panelBounds.left() + HUD_INSET, y, line.color(), false);
            y += lineHeight;
        }

        if (hudChatState.mode() == HudChatState.Mode.INPUT) {
            renderInputBar(context, client.textRenderer, snapshot);
        }
    }

    private void renderInputBar(DrawContext context, TextRenderer textRenderer, HudRenderSnapshot snapshot) {
        HudBounds inputBounds = snapshot.inputBounds();
        context.fill(inputBounds.left(), inputBounds.top(), inputBounds.right(), inputBounds.bottom(), 0xC0202020);
        String prompt = "> " + snapshot.inputText();
        context.drawText(textRenderer, prompt, inputBounds.left() + HUD_INSET, inputBounds.top() + 8, 0xFFFFFFFF, false);

        if ((System.currentTimeMillis() / 500) % 2 == 0) {
            context.fill(
                    snapshot.cursorX(),
                    inputBounds.top() + 6,
                    snapshot.cursorX() + 1,
                    inputBounds.bottom() - 6,
                    0xFFFFFFFF
            );
        }
    }

    private static List<RenderedLine> buildRenderedLines(List<ChatPanelScreen.ChatMessage> messages, TextRenderer textRenderer, int width) {
        List<RenderedLine> lines = new ArrayList<>();
        for (ChatPanelScreen.ChatMessage message : messages) {
            int color = message.role() == ChatPanelScreen.ChatRole.USER ? 0xFF7FD7FF : 0xFFF0F0F0;
            String prefix = message.role() == ChatPanelScreen.ChatRole.USER ? "You: " : "AI: ";
            Text text = Text.literal(prefix + message.text());
            List<OrderedText> wrapped = textRenderer.wrapLines(text, width);
            if (wrapped.isEmpty()) {
                OrderedText emptyLine = Text.literal(prefix).asOrderedText();
                lines.add(new RenderedLine(orderedTextToString(emptyLine), emptyLine, color));
                continue;
            }
            for (OrderedText wrappedLine : wrapped) {
                lines.add(new RenderedLine(orderedTextToString(wrappedLine), wrappedLine, color));
            }
        }
        return lines;
    }

    private static HudBounds inputBarBounds(int screenWidth, int screenHeight) {
        int left = HUD_MARGIN;
        int right = screenWidth - HUD_MARGIN;
        int bottom = screenHeight - HUD_MARGIN;
        int top = bottom - HUD_INPUT_HEIGHT;
        return new HudBounds(left, top, right, bottom);
    }

    private static String orderedTextToString(OrderedText text) {
        StringBuilder builder = new StringBuilder();
        text.accept((index, style, codePoint) -> {
            builder.appendCodePoint(codePoint);
            return true;
        });
        return builder.toString();
    }

    private void handleChatUserMessage(String message) {
        chatHistory.add(new ChatPanelScreen.ChatMessage(ChatPanelScreen.ChatRole.USER, message));
        assistantPending = true;
    }

    private void handleChatAssistantMessage(String message) {
        chatHistory.add(new ChatPanelScreen.ChatMessage(ChatPanelScreen.ChatRole.ASSISTANT, message));
        assistantPending = false;
        activeStatus = "";
    }

    private void handleChatStatus(String status) {
        activeStatus = status;
        assistantPending = true;
    }

    private BuildChatContext captureBuildChatContext() {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == null || client.world == null) {
            throw new IllegalStateException("chat requires an active player and world");
        }

        String worldId = worldIdResolver.resolve(client);
        WorldContextSnapshot snapshot = captureWorldContextSnapshot(client, SNAPSHOT_RADIUS);
        return new BuildChatContext(worldId, snapshot.toJson());
    }

    private WorldContextSnapshot captureWorldContextSnapshot(MinecraftClient client, int radius) {
        if (client.player == null || client.world == null) {
            throw new IllegalStateException("snapshot requires an active player and world");
        }

        BlockPos center = client.player.getBlockPos();
        ClientWorld world = client.world;
        TreeMap<String, String> blocks = new TreeMap<>();

        for (int dx = -radius; dx <= radius; dx++) {
            for (int dy = -radius; dy <= radius; dy++) {
                for (int dz = -radius; dz <= radius; dz++) {
                    BlockPos pos = center.add(dx, dy, dz);
                    String blockId = normalizeBlockId(Registries.BLOCK.getId(world.getBlockState(pos).getBlock()).toString());
                    if (!"minecraft:air".equals(blockId)) {
                        blocks.put(coordKey(pos.getX(), pos.getY(), pos.getZ()), blockId);
                    }
                }
            }
        }

        return new WorldContextSnapshot(
                new WorldContextSnapshot.PlayerSnapshot(
                        center.getX(),
                        center.getY(),
                        center.getZ(),
                        client.player.getHorizontalFacing().asString(),
                        world.getRegistryKey().getValue().toString()
                ),
                blocks
        );
    }

    private void handleBuildApply(BuildApplyRequest request) {
        BuildApplyResult result;
        try {
            result = applyBuildRequest(MinecraftClient.getInstance(), request);
            latestStatusMessage = "Applied " + result.appliedCount() + " block changes";
        } catch (Exception error) {
            result = new BuildApplyResult(false, error.getMessage(), 0, 0, 0);
            latestStatusMessage = "build apply failed: " + error.getMessage();
        }

        BuildApplyResult finalResult = result;
        workerExecutor.execute(() -> backend.reportBuildResult(request.jobId(), finalResult));
    }

    private BuildApplyResult applyBuildRequest(MinecraftClient client, BuildApplyRequest request) {
        if (client.player == null || client.world == null || client.getNetworkHandler() == null) {
            throw new IllegalStateException("build.apply requires an active player, world, and network handler");
        }

        BuildApplicationPlanner.Plan plan = BuildApplicationPlanner.plan(
                request.placements(),
                (x, y, z) -> currentBlockIdAt(client.world, x, y, z)
        );

        for (PlacementBatchPlanner.Cuboid cuboid : plan.fillCuboids()) {
            sendCommand(client, fillCommand(
                    cuboid.minX(),
                    cuboid.minY(),
                    cuboid.minZ(),
                    cuboid.maxX(),
                    cuboid.maxY(),
                    cuboid.maxZ(),
                    cuboid.blockId()
            ));
        }

        for (PlacementBatchPlanner.Placement setBlock : plan.setBlocks()) {
            sendCommand(client, setblockCommand(setBlock.x(), setBlock.y(), setBlock.z(), setBlock.blockId()));
        }

        undoPlacements = plan.undoPlacements();
        hasUndoState = true;

        return new BuildApplyResult(
                true,
                null,
                plan.appliedCount(),
                plan.fillCuboids().size(),
                plan.setBlocks().size()
        );
    }

    private String currentBlockIdAt(ClientWorld world, int x, int y, int z) {
        BlockState state = world.getBlockState(new BlockPos(x, y, z));
        return normalizeBlockId(Registries.BLOCK.getId(state.getBlock()).toString());
    }

    private String fillCommand(int minX, int minY, int minZ, int maxX, int maxY, int maxZ, String blockId) {
        return "fill " + minX + " " + minY + " " + minZ + " " + maxX + " " + maxY + " " + maxZ + " " + blockId + " replace";
    }

    private String setblockCommand(int x, int y, int z, String blockId) {
        return "setblock " + x + " " + y + " " + z + " " + blockId + " replace";
    }

    private void sendCommand(MinecraftClient client, String command) {
        if (client.getNetworkHandler() == null) {
            throw new IllegalStateException("Cannot send command without network handler");
        }
        client.getNetworkHandler().sendChatCommand(command);
    }

    private String normalizeBlockId(String blockId) {
        int bracketIndex = blockId.indexOf('[');
        if (bracketIndex < 0) {
            return blockId;
        }
        return blockId.substring(0, bracketIndex);
    }

    private String coordKey(int x, int y, int z) {
        return x + "," + y + "," + z;
    }

    private void runHudTestCommand(MinecraftClient client) {
        if (client.player == null) {
            return;
        }

        if (hudCaptureSession != null) {
            restoreHudDebugState(hudCaptureSession.previousState);
        }

        latestHudTestJsonPath = null;
        HudDebugState previousState = snapshotHudDebugState();
        hudCaptureSession = new HudCaptureSession(
                Instant.now().toEpochMilli(),
                previousState,
                List.of(
                        new HudCaptureTarget(HudChatState.Mode.HIDDEN, "hidden"),
                        new HudCaptureTarget(HudChatState.Mode.HUD, "hud"),
                        new HudCaptureTarget(HudChatState.Mode.INPUT, "input")
                )
        );
        prepareHudCaptureState(hudCaptureSession.currentTarget());
        hudCaptureSession.settleTicksRemaining = HUD_TEST_SETTLE_TICKS;
        client.player.sendMessage(Text.literal("Running /hud-test captures"), true);
    }

    private HudDebugState snapshotHudDebugState() {
        return new HudDebugState(
                List.copyOf(chatHistory),
                activeStatus,
                assistantPending,
                hudChatState.snapshot()
        );
    }

    private void restoreHudDebugState(HudDebugState state) {
        chatHistory.clear();
        chatHistory.addAll(state.chatHistory());
        activeStatus = state.activeStatus();
        assistantPending = state.assistantPending();
        hudChatState.restore(state.hudState());
    }

    private void prepareHudCaptureState(HudCaptureTarget target) {
        chatHistory.clear();
        chatHistory.add(new ChatPanelScreen.ChatMessage(ChatPanelScreen.ChatRole.USER, "build a lantern arch over the path"));
        chatHistory.add(new ChatPanelScreen.ChatMessage(ChatPanelScreen.ChatRole.ASSISTANT, "Applied 38 block changes. The build program used 3 primitives and produced 38 changed voxels."));
        activeStatus = "Applying 38 block changes to the client world.";
        assistantPending = false;

        switch (target.mode()) {
            case HIDDEN -> hudChatState.restore(new HudChatState.Snapshot(HudChatState.Mode.HIDDEN, "", 0));
            case HUD -> hudChatState.restore(new HudChatState.Snapshot(HudChatState.Mode.HUD, "", 0));
            case INPUT -> {
                String input = "/chat add lanterns to the arch";
                hudChatState.restore(new HudChatState.Snapshot(HudChatState.Mode.INPUT, input, input.length()));
            }
        }
    }

    private void tickHudCaptureSession(MinecraftClient client) {
        HudCaptureSession session = hudCaptureSession;
        if (session == null) {
            return;
        }
        if (session.settleTicksRemaining > 0) {
            session.settleTicksRemaining--;
            return;
        }

        try {
            captureHudTestArtifact(client, session, session.currentTarget());
            session.captureIndex++;
            if (session.captureIndex >= session.targets.size()) {
                Path manifestPath = writeHudTestManifest(client, session);
                latestHudTestJsonPath = manifestPath;
                restoreHudDebugState(session.previousState);
                hudCaptureSession = null;
                if (client.player != null) {
                    client.player.sendMessage(Text.literal("Saved /hud-test artifacts to " + manifestPath), true);
                }
                if (Boolean.getBoolean(HUD_TEST_EXIT_ON_COMPLETE_PROPERTY)) {
                    client.scheduleStop();
                }
                return;
            }

            prepareHudCaptureState(session.currentTarget());
            session.settleTicksRemaining = HUD_TEST_SETTLE_TICKS;
        } catch (IOException error) {
            throw new RuntimeException("Failed to capture /hud-test artifacts", error);
        }
    }

    private void captureHudTestArtifact(MinecraftClient client, HudCaptureSession session, HudCaptureTarget target) throws IOException {
        long capturedAtMillis = System.currentTimeMillis();
        Path runDir = client.runDirectory.toPath();
        Path hudTestDir = runDir.resolve("browsecraft").resolve("hud-test");
        Files.createDirectories(hudTestDir);
        String screenshotName = "browsecraft-hud-test-" + session.sessionTimestamp + "-" + target.label() + ".png";
        Path screenshotPath = runDir.resolve("screenshots").resolve(screenshotName).toAbsolutePath();

        ScreenshotRecorder.saveScreenshot(
                client.runDirectory,
                screenshotName,
                client.getFramebuffer(),
                1,
                message -> {
                }
        );

        session.captures.add(hudCaptureToJson(target, screenshotPath, capturedAtMillis));
    }

    private Path writeHudTestManifest(MinecraftClient client, HudCaptureSession session) throws IOException {
        Path hudTestDir = client.runDirectory.toPath().resolve("browsecraft").resolve("hud-test");
        Files.createDirectories(hudTestDir);

        JsonObject root = new JsonObject();
        root.addProperty("trigger", "hud-test");
        root.addProperty("session_timestamp_ms", session.sessionTimestamp);
        root.addProperty("run_directory", client.runDirectory.toPath().toAbsolutePath().toString());
        root.addProperty("latest_status_message", latestStatusMessage);
        root.addProperty("auto_started", hudTestStartupTriggered);
        root.addProperty("auto_exit_enabled", Boolean.getBoolean(HUD_TEST_EXIT_ON_COMPLETE_PROPERTY));

        JsonArray captures = new JsonArray();
        for (JsonObject capture : session.captures) {
            captures.add(capture.deepCopy());
        }
        root.add("captures", captures);

        String payload = GSON.toJson(root);
        Path manifestPath = hudTestDir.resolve("hud-test-" + session.sessionTimestamp + ".json");
        Path latestManifestPath = hudTestDir.resolve("latest.json");
        Files.writeString(manifestPath, payload);
        Files.writeString(latestManifestPath, payload);
        return manifestPath;
    }

    private JsonObject hudCaptureToJson(HudCaptureTarget target, Path screenshotPath, long capturedAtMillis) {
        HudRenderSnapshot snapshot = latestHudRenderSnapshot;
        JsonObject capture = new JsonObject();
        capture.addProperty("label", target.label());
        capture.addProperty("mode", target.mode().name());
        capture.addProperty("captured_at_ms", capturedAtMillis);
        capture.addProperty("screenshot_path", screenshotPath.toString());
        capture.addProperty("visible", snapshot.visible());
        capture.addProperty("screen_width", snapshot.screenWidth());
        capture.addProperty("screen_height", snapshot.screenHeight());
        capture.addProperty("header", snapshot.header());
        capture.addProperty("active_status_text", snapshot.activeStatus());
        capture.addProperty("assistant_streaming", snapshot.assistantPending());
        capture.addProperty("input_text", snapshot.inputText());
        capture.addProperty("cursor_index", snapshot.cursorIndex());
        capture.addProperty("cursor_x", snapshot.cursorX());
        capture.addProperty("visible_start_index", snapshot.visibleStartIndex());
        if (snapshot.panelBounds() != null) {
            capture.add("panel_bounds", hudBoundsToJson(snapshot.panelBounds()));
        }
        if (snapshot.inputBounds() != null) {
            capture.add("input_bounds", hudBoundsToJson(snapshot.inputBounds()));
        }

        JsonArray wrappedLines = new JsonArray();
        for (RenderedLine line : snapshot.wrappedLines()) {
            wrappedLines.add(line.plainText());
        }
        capture.add("wrapped_lines", wrappedLines);

        JsonArray visibleWrappedLines = new JsonArray();
        for (int index = snapshot.visibleStartIndex(); index < snapshot.wrappedLines().size(); index++) {
            visibleWrappedLines.add(snapshot.wrappedLines().get(index).plainText());
        }
        capture.add("visible_wrapped_lines", visibleWrappedLines);
        return capture;
    }

    private JsonObject hudBoundsToJson(HudBounds bounds) {
        JsonObject json = new JsonObject();
        json.addProperty("left", bounds.left());
        json.addProperty("top", bounds.top());
        json.addProperty("right", bounds.right());
        json.addProperty("bottom", bounds.bottom());
        json.addProperty("width", bounds.right() - bounds.left());
        json.addProperty("height", bounds.bottom() - bounds.top());
        return json;
    }

    private record HudBounds(int left, int top, int right, int bottom) {
    }

    private record RenderedLine(String plainText, OrderedText orderedText, int color) {
    }

    private record HudRenderSnapshot(
            HudChatState.Mode mode,
            boolean visible,
            int screenWidth,
            int screenHeight,
            String header,
            String activeStatus,
            boolean assistantPending,
            HudBounds panelBounds,
            HudBounds inputBounds,
            List<RenderedLine> wrappedLines,
            int visibleStartIndex,
            String inputText,
            int cursorIndex,
            int cursorX
    ) {
    }

    private record HudCaptureTarget(HudChatState.Mode mode, String label) {
    }

    private static final class HudCaptureSession {
        private final long sessionTimestamp;
        private final HudDebugState previousState;
        private final List<HudCaptureTarget> targets;
        private final List<JsonObject> captures = new ArrayList<>();
        private int captureIndex;
        private int settleTicksRemaining;

        private HudCaptureSession(long sessionTimestamp, HudDebugState previousState, List<HudCaptureTarget> targets) {
            this.sessionTimestamp = sessionTimestamp;
            this.previousState = previousState;
            this.targets = List.copyOf(targets);
        }

        private HudCaptureTarget currentTarget() {
            return targets.get(captureIndex);
        }
    }

    private record HudDebugState(
            List<ChatPanelScreen.ChatMessage> chatHistory,
            String activeStatus,
            boolean assistantPending,
            HudChatState.Snapshot hudState
    ) {
    }
}
