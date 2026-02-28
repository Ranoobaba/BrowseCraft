package dev.browsecraft.mod;

public interface BuildBackendListener {
    void onStatus(String jobId, String stage, String message);

    void onReady(String jobId, String sourceType, String sourceUrl, double confidence, BuildPlan plan);

    void onError(String jobId, String code, String message);
}
