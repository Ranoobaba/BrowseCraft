package dev.browsecraft.mod;

import com.google.gson.JsonObject;

import java.util.Map;
import java.util.TreeMap;

public record WorldContextSnapshot(PlayerSnapshot player, Map<String, String> blocks) {
    public JsonObject toJson() {
        JsonObject root = new JsonObject();
        root.add("player", player.toJson());

        JsonObject blocksJson = new JsonObject();
        TreeMap<String, String> orderedBlocks = new TreeMap<>(blocks);
        for (Map.Entry<String, String> entry : orderedBlocks.entrySet()) {
            blocksJson.addProperty(entry.getKey(), entry.getValue());
        }
        root.add("blocks", blocksJson);
        return root;
    }

    public record PlayerSnapshot(int x, int y, int z, String facing, String dimension) {
        JsonObject toJson() {
            JsonObject json = new JsonObject();
            json.addProperty("x", x);
            json.addProperty("y", y);
            json.addProperty("z", z);
            json.addProperty("facing", facing);
            json.addProperty("dimension", dimension);
            return json;
        }
    }
}
