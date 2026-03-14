package dev.browsecraft.mod;

import java.util.List;

public record BuildApplyRequest(
        String jobId,
        String worldId,
        String sessionId,
        int primitiveCount,
        double executionTimeMs,
        List<AbsoluteBuildPlacement> placements
) {
}
