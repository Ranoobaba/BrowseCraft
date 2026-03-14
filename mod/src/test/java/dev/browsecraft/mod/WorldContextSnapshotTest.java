package dev.browsecraft.mod;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class WorldContextSnapshotTest {
    @Test
    void serializationOrdersCoordinateKeysDeterministically() {
        Map<String, String> blocks = new LinkedHashMap<>();
        blocks.put("2,64,0", "minecraft:stone");
        blocks.put("1,64,0", "minecraft:oak_planks");

        WorldContextSnapshot snapshot = new WorldContextSnapshot(
                new WorldContextSnapshot.PlayerSnapshot(0, 64, 0, "north", "minecraft:overworld"),
                blocks
        );

        JsonObject json = snapshot.toJson();
        JsonObject blocksJson = json.getAsJsonObject("blocks");
        assertEquals(List.of("1,64,0", "2,64,0"), List.copyOf(blocksJson.keySet()));
    }
}
