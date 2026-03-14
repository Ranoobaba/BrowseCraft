package dev.browsecraft.mod;

public record BuildApplyResult(
        boolean success,
        String error,
        int appliedCount,
        int fillCount,
        int setblockCount
) {
}
