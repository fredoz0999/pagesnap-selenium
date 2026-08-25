import org.openqa.selenium.By;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.support.ui.WebDriverWait;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Verifies Selenium multi-tab snapshot behavior against Snapshot Lab.
 *
 * Exercises the same control flow as SnapshotCapture:
 *   - detect new window handle
 *   - poll all tabs for window.__snapshotCapture
 *   - switchTo the signaling tab before running CAPTURE_TREE_JS
 *
 * Usage (from pagesnap-selenium/):
 *   java -cp "target/classes;$(cat target/cp.txt)" MultiTabBugHunt http://localhost:4173
 */
public class MultiTabBugHunt {

    private static final DateTimeFormatter FOLDER_TS =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH-mm-ss").withZone(ZoneId.of("America/New_York"));

    private record Finding(String severity, String message) {}

    public static void main(String[] args) throws Exception {
        SnapshotCapture.useUtf8Console();
        String base = args.length > 0 && !args[0].isBlank() ? args[0] : "http://localhost:4173";
        String stamp = FOLDER_TS.format(Instant.now());
        Path outDir = Path.of("pageSnapshots", "session-multitab-bug-hunt-se-" + stamp);
        Files.createDirectories(outDir);

        List<Finding> findings = new ArrayList<>();
        Path cfg = Path.of("capture.config.properties");
        if (Files.exists(cfg)) {
            for (String line : Files.readAllLines(cfg, StandardCharsets.UTF_8)) {
                String t = line.trim();
                if (t.startsWith("chromeDriverPath=") && t.length() > "chromeDriverPath=".length()) {
                    String p = t.substring("chromeDriverPath=".length()).trim();
                    if (!p.isEmpty() && !p.startsWith("#")) {
                        System.setProperty("webdriver.chrome.driver", p);
                    }
                }
            }
        }

        ChromeOptions options = new ChromeOptions();
        options.addArguments("--headless=new", "--window-size=1400,900", "--disable-gpu");
        WebDriver driver = new ChromeDriver(options);
        JavascriptExecutor js = (JavascriptExecutor) driver;

        System.out.println("Selenium multi-tab bug-hunt");
        System.out.println("  Base URL: " + base);
        System.out.println("  Output:   " + outDir.toAbsolutePath());

        try {
            driver.get(base);
            new WebDriverWait(driver, Duration.ofSeconds(15))
                    .until(d -> d.findElement(By.id("tab-tabs")).isDisplayed());

            // Go to New tab playground
            js.executeScript("document.getElementById('tab-tabs').click();");
            Thread.sleep(250);

            String primary = driver.getWindowHandle();
            Set<String> before = new LinkedHashSet<>(driver.getWindowHandles());
            System.out.println("  Primary handle: " + shortHandle(primary) + "  tabs=" + before.size());

            // Open secondary tab via window.open (same as lab button)
            driver.findElement(By.id("open-new-tab-js")).click();

            String secondary = waitForNewHandle(driver, before, Duration.ofSeconds(10));
            if (secondary == null) {
                findings.add(new Finding("bug", "No new window handle after open-new-tab-js click"));
                writeReport(outDir, base, findings, false);
                System.exit(2);
            }
            System.out.println("  Secondary handle: " + shortHandle(secondary));

            // --- Step 1: capture secondary while focused on it ---
            driver.switchTo().window(secondary);
            new WebDriverWait(driver, Duration.ofSeconds(10))
                    .until(d -> d.getCurrentUrl() != null && d.getCurrentUrl().contains("/new-tab"));
            Thread.sleep(300);
            String urlSecondary = driver.getCurrentUrl();
            String treeSecondary = captureTree(js);
            writeYaml(outDir, "01_secondary_focused.yaml", urlSecondary, "Secondary tab (focused)", treeSecondary);
            System.out.println("  [1] Secondary focused capture  url=" + urlSecondary
                    + "  lines=" + lineCount(treeSecondary));

            assertContains(findings, "01_secondary_focused", urlSecondary, "/new-tab");
            assertContains(findings, "01_secondary_focused", treeSecondary, "Opened in a new tab");
            assertContains(findings, "01_secondary_focused", treeSecondary, "new-tab-code");
            assertContains(findings, "01_secondary_focused", treeSecondary, "TAB-2026");
            assertContains(findings, "01_secondary_focused", treeSecondary, "Promo code");
            assertNotContains(findings, "01_secondary_focused", treeSecondary, "Snapshot Lab");

            // --- Step 2: capture primary while focused on it ---
            driver.switchTo().window(primary);
            Thread.sleep(200);
            String urlPrimary = driver.getCurrentUrl();
            String treePrimary = captureTree(js);
            writeYaml(outDir, "02_primary_focused.yaml", urlPrimary, "Primary tab (focused)", treePrimary);
            System.out.println("  [2] Primary focused capture  url=" + urlPrimary
                    + "  lines=" + lineCount(treePrimary));

            assertContains(findings, "02_primary_focused", treePrimary, "Snapshot Lab");
            assertContains(findings, "02_primary_focused", treePrimary, "Open new tab");
            assertNotContains(findings, "02_primary_focused", treePrimary, "Opened in a new tab");
            assertNotContains(findings, "02_primary_focused", urlPrimary, "/new-tab");

            // --- Step 3: SnapshotCapture multi-tab poll path ---
            // Signal capture from SECONDARY while driver is resting on PRIMARY.
            // Poll all handles (like SnapshotCapture), switch to signaling tab, capture.
            driver.switchTo().window(secondary);
            js.executeScript(
                    "window.__snapshotNote = 'from-secondary-while-primary-resting';"
                            + "window.__snapshotCapture = true;");
            driver.switchTo().window(primary); // rest on primary - wrong tab if multi-tab broken

            PollResult poll = pollForCapture(driver, Duration.ofSeconds(5));
            if (poll.captureHandle == null) {
                findings.add(new Finding("bug",
                        "Poll did not see __snapshotCapture on any tab (multi-tab signal lost)"));
            } else {
                System.out.println("  [3] Poll found capture signal on handle=" + shortHandle(poll.captureHandle)
                        + " note=\"" + poll.note + "\"");
                if (!secondary.equals(poll.captureHandle)) {
                    findings.add(new Finding("bug",
                            "Capture signal attributed to wrong tab: expected secondary "
                                    + shortHandle(secondary) + " got " + shortHandle(poll.captureHandle)));
                }
                if (!"from-secondary-while-primary-resting".equals(poll.note)) {
                    findings.add(new Finding("bug",
                            "Capture note not preserved across poll: got \"" + poll.note + "\""));
                }

                // Switch to signaling tab (as SnapshotCapture does) and capture
                driver.switchTo().window(poll.captureHandle);
                js = (JavascriptExecutor) driver;
                String urlPolled = driver.getCurrentUrl();
                String treePolled = captureTree(js);
                writeYaml(outDir, "03_poll_secondary_signal.yaml", urlPolled,
                        "Poll path: signal from secondary while resting on primary", treePolled);
                System.out.println("  [3] Poll-path capture  url=" + urlPolled
                        + "  lines=" + lineCount(treePolled));

                assertContains(findings, "03_poll_path", urlPolled, "/new-tab");
                assertContains(findings, "03_poll_path", treePolled, "Opened in a new tab");
                assertContains(findings, "03_poll_path", treePolled, "TAB-2026");
                assertNotContains(findings, "03_poll_path", treePolled, "Open new tab (window.open)");

                // Flag should have been cleared by poll
                Object stillSet = js.executeScript("return window.__snapshotCapture === true;");
                if (Boolean.TRUE.equals(stillSet)) {
                    findings.add(new Finding("bug",
                            "__snapshotCapture still true after poll cleared it"));
                }
            }

            // --- Step 4: reverse - signal from primary while resting on secondary ---
            driver.switchTo().window(primary);
            js = (JavascriptExecutor) driver;
            js.executeScript(
                    "window.__snapshotNote = 'from-primary-while-secondary-resting';"
                            + "window.__snapshotCapture = true;");
            driver.switchTo().window(secondary);

            PollResult poll2 = pollForCapture(driver, Duration.ofSeconds(5));
            if (poll2.captureHandle == null) {
                findings.add(new Finding("bug",
                        "Reverse poll did not see __snapshotCapture on primary"));
            } else {
                if (!primary.equals(poll2.captureHandle)) {
                    findings.add(new Finding("bug",
                            "Reverse poll wrong tab: expected primary " + shortHandle(primary)
                                    + " got " + shortHandle(poll2.captureHandle)));
                }
                driver.switchTo().window(poll2.captureHandle);
                js = (JavascriptExecutor) driver;
                String urlP2 = driver.getCurrentUrl();
                String treeP2 = captureTree(js);
                writeYaml(outDir, "04_poll_primary_signal.yaml", urlP2,
                        "Poll path: signal from primary while resting on secondary", treeP2);
                System.out.println("  [4] Reverse poll-path capture  url=" + urlP2
                        + "  lines=" + lineCount(treeP2));

                assertContains(findings, "04_reverse_poll", treeP2, "Snapshot Lab");
                assertNotContains(findings, "04_reverse_poll", treeP2, "Opened in a new tab");
            }

            // --- Step 5: both tabs still open after captures ---
            Set<String> still = driver.getWindowHandles();
            if (still.size() < 2) {
                findings.add(new Finding("bug",
                        "Expected 2+ window handles after multi-tab captures, got " + still.size()));
            } else {
                System.out.println("  [5] Handles remaining: " + still.size() + " (ok)");
            }

        } catch (Exception e) {
            findings.add(new Finding("bug", "Harness threw: " + e.getMessage()));
            e.printStackTrace(System.err);
        } finally {
            try {
                driver.quit();
            } catch (Exception ignored) {
                // ignore
            }
        }

        boolean ok = writeReport(outDir, base, findings, true);
        System.exit(ok ? 0 : 2);
    }

    private static class PollResult {
        String captureHandle;
        String note = "";
    }

    /**
     * Mirrors SnapshotCapture's multi-tab poll: visit every handle, look for
     * __snapshotCapture, clear flag, return which tab signaled.
     */
    private static PollResult pollForCapture(WebDriver driver, Duration timeout) throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        PollResult result = new PollResult();
        while (System.nanoTime() < deadline) {
            Set<String> handles = driver.getWindowHandles();
            for (String h : handles) {
                try {
                    driver.switchTo().window(h);
                    JavascriptExecutor js = (JavascriptExecutor) driver;
                    Object flag = js.executeScript("return window.__snapshotCapture === true;");
                    if (Boolean.TRUE.equals(flag)) {
                        js.executeScript("window.__snapshotCapture = false;");
                        Object noteObj = js.executeScript("return window.__snapshotNote || '';");
                        result.note = noteObj != null ? noteObj.toString() : "";
                        js.executeScript("window.__snapshotNote = '';");
                        result.captureHandle = h;
                        return result;
                    }
                } catch (org.openqa.selenium.WebDriverException ignored) {
                    // tab may have closed
                }
            }
            Thread.sleep(100);
        }
        return result;
    }

    private static String waitForNewHandle(WebDriver driver, Set<String> before, Duration timeout)
            throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            for (String h : driver.getWindowHandles()) {
                if (!before.contains(h)) return h;
            }
            Thread.sleep(100);
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static String captureTree(JavascriptExecutor js) {
        Map<String, Object> opts = new LinkedHashMap<>();
        opts.put("maxTableRows", 5);
        opts.put("redactPasswords", true);
        opts.put("redactEmails", true);
        Object result = js.executeScript(SnapshotCapture.CAPTURE_TREE_JS, opts);
        if (result instanceof Map<?, ?> map) {
            Object t = map.get("tree");
            return t != null ? t.toString() : "";
        }
        return result != null ? result.toString() : "";
    }

    private static void writeYaml(Path outDir, String file, String url, String note, String tree)
            throws Exception {
        StringBuilder sb = new StringBuilder();
        sb.append("# URL: ").append(url).append('\n');
        sb.append("# Captured: ").append(Instant.now()).append('\n');
        sb.append("# Engine: selenium multi-tab bug-hunt\n");
        sb.append("# Note: ").append(note).append('\n');
        sb.append('\n');
        sb.append(tree).append('\n');
        Files.writeString(outDir.resolve(file), sb.toString(), StandardCharsets.UTF_8);
    }

    private static void assertContains(List<Finding> findings, String step, String hay, String needle) {
        if (hay == null || !hay.contains(needle)) {
            findings.add(new Finding("bug",
                    step + ": expected to contain \"" + needle + "\""));
        }
    }

    private static void assertNotContains(List<Finding> findings, String step, String hay, String needle) {
        if (hay != null && hay.contains(needle)) {
            findings.add(new Finding("bug",
                    step + ": expected NOT to contain \"" + needle + "\""));
        }
    }

    private static long lineCount(String s) {
        if (s == null || s.isBlank()) return 0;
        return s.lines().count();
    }

    private static String shortHandle(String handle) {
        if (handle == null) return "?";
        return handle.length() <= 8 ? handle : handle.substring(0, 8) + "...";
    }

    private static boolean writeReport(Path outDir, String base, List<Finding> findings, boolean print)
            throws Exception {
        long bugs = findings.stream().filter(f -> "bug".equals(f.severity())).count();
        StringBuilder report = new StringBuilder();
        report.append("# Selenium multi-tab bug-hunt report\n\n");
        report.append("- Base URL: ").append(base).append('\n');
        report.append("- Bugs: ").append(bugs).append('\n');
        report.append("- Output: ").append(outDir.toAbsolutePath()).append("\n\n");
        report.append("## Checks\n\n");
        report.append("1. Open secondary tab via lab `open-new-tab-js`\n");
        report.append("2. Capture while focused on secondary -> must be `/new-tab` content\n");
        report.append("3. Capture while focused on primary -> must be lab launcher content\n");
        report.append("4. Poll path: signal on secondary while resting on primary -> capture secondary\n");
        report.append("5. Reverse poll: signal on primary while resting on secondary -> capture primary\n\n");
        report.append("## Findings\n\n");
        if (findings.isEmpty()) {
            report.append("_No findings - multi-tab snapshot routing looks correct._\n");
        } else {
            for (Finding f : findings) {
                report.append("- **[").append(f.severity().toUpperCase()).append("]** ")
                        .append(f.message()).append('\n');
            }
        }
        report.append('\n');
        Path reportPath = outDir.resolve("BUG_HUNT_REPORT.md");
        Files.writeString(reportPath, report.toString(), StandardCharsets.UTF_8);
        if (print) {
            System.out.println("\n==== REPORT ====");
            System.out.println(report);
            System.out.println("Wrote " + reportPath.toAbsolutePath());
        }
        return bugs == 0;
    }
}
