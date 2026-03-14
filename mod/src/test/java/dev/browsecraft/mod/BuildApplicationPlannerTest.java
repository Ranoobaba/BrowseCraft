package dev.browsecraft.mod;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class BuildApplicationPlannerTest {
    @Test
    void plannerDeduplicatesTargetsAndCapturesUndoPlacements() {
        BuildApplicationPlanner.Plan plan = BuildApplicationPlanner.plan(
                List.of(
                        new AbsoluteBuildPlacement(1, 64, 1, "minecraft:stone"),
                        new AbsoluteBuildPlacement(1, 64, 1, "minecraft:oak_planks"),
                        new AbsoluteBuildPlacement(2, 64, 1, "minecraft:oak_planks")
                ),
                (x, y, z) -> "minecraft:dirt"
        );

        assertEquals(2, plan.appliedCount());
        assertEquals(2, plan.undoPlacements().size());
        assertEquals("minecraft:dirt", plan.undoPlacements().getFirst().blockId());
        assertEquals(1, plan.fillCuboids().size());
        assertEquals("minecraft:oak_planks", plan.fillCuboids().getFirst().blockId());
    }
}
