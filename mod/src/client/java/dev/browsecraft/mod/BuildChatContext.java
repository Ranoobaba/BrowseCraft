package dev.browsecraft.mod;

import com.google.gson.JsonObject;

public record BuildChatContext(String worldId, JsonObject worldContext) {
}
