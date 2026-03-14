package dev.browsecraft.mod;

import net.minecraft.util.math.BlockPos;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class BuildApplicationPlanner {
    private BuildApplicationPlanner() {
    }

    public static Plan plan(List<AbsoluteBuildPlacement> placements, BlockLookup blockLookup) {
        if (placements.isEmpty()) {
            throw new IllegalArgumentException("placements must not be empty");
        }

        Map<BlockPos, String> targetByPos = new LinkedHashMap<>();
        for (AbsoluteBuildPlacement placement : placements) {
            targetByPos.put(new BlockPos(placement.x(), placement.y(), placement.z()), placement.blockId());
        }

        List<PlacementBatchPlanner.Placement> plannerInput = new ArrayList<>(targetByPos.size());
        List<AbsoluteBuildPlacement> undoPlacements = new ArrayList<>(targetByPos.size());
        for (Map.Entry<BlockPos, String> entry : targetByPos.entrySet()) {
            BlockPos pos = entry.getKey();
            plannerInput.add(new PlacementBatchPlanner.Placement(pos.getX(), pos.getY(), pos.getZ(), entry.getValue()));
            undoPlacements.add(new AbsoluteBuildPlacement(
                    pos.getX(),
                    pos.getY(),
                    pos.getZ(),
                    blockLookup.blockIdAt(pos.getX(), pos.getY(), pos.getZ())
            ));
        }

        PlacementBatchPlanner.Plan placementPlan = PlacementBatchPlanner.plan(plannerInput);
        return new Plan(placementPlan.fillCuboids(), placementPlan.setBlocks(), List.copyOf(undoPlacements), targetByPos.size());
    }

    @FunctionalInterface
    public interface BlockLookup {
        String blockIdAt(int x, int y, int z);
    }

    public record Plan(
            List<PlacementBatchPlanner.Cuboid> fillCuboids,
            List<PlacementBatchPlanner.Placement> setBlocks,
            List<AbsoluteBuildPlacement> undoPlacements,
            int appliedCount
    ) {
    }
}
