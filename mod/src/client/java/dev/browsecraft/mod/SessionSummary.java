package dev.browsecraft.mod;

public record SessionSummary(
        String sessionId,
        int messageCount,
        String createdAt,
        String updatedAt
) {
}
