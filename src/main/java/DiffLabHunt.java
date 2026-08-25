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
import java.util.List;
import java.util.Map;

/**
 * Automated Diff playground harness: capture trees between UI actions and
 * verify SnapshotCapture.simpleDiff output (NN_diff.md semantics).
 *
 * Usage (from pagesnap-selenium/, lab on :4173):
 *   mvn -q compile exec:java -Dexec.mainClass=DiffLabHunt -Dexec.args="http://localhost:4173"
 */
public class DiffLabHunt {

    private static final DateTimeFormatter FOLDER_TS =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH-mm-ss").withZone(ZoneId.of("America/New_York"));

    private record Finding(String step, String severity, String message) {}

    private record Step(String id, String note, Runnable action) {}

    public static void main(String[] args) throws Exception {
        SnapshotCapture.useUtf8Console();
        String base = args.length > 0 && !args[0].isBlank() ? args[0] : "http://localhost:4173";

        String stamp = FOLDER_TS.format(Instant.now());
        Path outDir = Path.of("pageSnapshots", "session-diff-lab-hunt-se-" + stamp);
        Files.createDirectories(outDir);

        List<Finding> findings = new ArrayList<>();
        loadChromeDriverFromConfig();

        ChromeOptions options = new ChromeOptions();
        options.addArguments("--headless=new", "--window-size=1400,900", "--disable-gpu");
        WebDriver driver = new ChromeDriver(options);
        JavascriptExecutor js = (JavascriptExecutor) driver;

        System.out.println("Diff lab hunt (Selenium engine + simpleDiff)");
        System.out.println("  Base URL: " + base);
        System.out.println("  Output:   " + outDir.toAbsolutePath());

        String lastTree = "";
        String lastUrl = "";
        int stepN = 0;

        try {
            driver.get(base);
            new WebDriverWait(driver, Duration.ofSeconds(15))
                    .until(d -> d.findElement(By.id("tab-diff-lab")).isDisplayed());

            // Open Diff playground section
            js.executeScript("document.getElementById('tab-diff-lab').click();");
            Thread.sleep(300);
            new WebDriverWait(driver, Duration.ofSeconds(10))
                    .until(d -> d.findElement(By.id("diff-lab-root")).isDisplayed());

            List<Step> steps = List.of(
                    new Step("01_baseline", "Baseline (closed menu, 1 item, Alpha first)", null),
                    new Step("02_menu_open", "Status menu open", () -> {
                        driver.findElement(By.id("diff-status-trigger")).click();
                        try {
                            Thread.sleep(200);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }),
                    new Step("03_count_plus2", "Add two queue items (menu closed)", () -> {
                        // close menu if open
                        try {
                            Boolean open = (Boolean) ((JavascriptExecutor) driver).executeScript(
                                    "var b=document.getElementById('diff-status-trigger');"
                                            + "return b && b.getAttribute('aria-expanded')==='true';");
                            if (Boolean.TRUE.equals(open)) {
                                driver.findElement(By.id("diff-status-trigger")).click();
                                Thread.sleep(150);
                            }
                        } catch (Exception ignored) {
                            // continue
                        }
                        driver.findElement(By.id("diff-add-item")).click();
                        driver.findElement(By.id("diff-add-item")).click();
                        try {
                            Thread.sleep(150);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }),
                    new Step("04_swap", "Swap Alpha/Beta order", () -> {
                        driver.findElement(By.id("diff-swap")).click();
                        try {
                            Thread.sleep(150);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }),
                    new Step("05_validate", "Validate empty claim code (alert)", () -> {
                        driver.findElement(By.id("diff-validate")).click();
                        try {
                            Thread.sleep(150);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }),
                    new Step("06_toast", "Show sticky toast", () -> {
                        driver.findElement(By.id("diff-show-toast")).click();
                        try {
                            Thread.sleep(150);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    })
            );

            for (Step sc : steps) {
                stepN++;
                System.out.printf("%n[%d/%d] %s: %s%n", stepN, steps.size(), sc.id(), sc.note());
                try {
                    if (sc.action() != null) {
                        sc.action().run();
                    }

                    String tree = captureTree(js);
                    String url = driver.getCurrentUrl();
                    writeYaml(outDir, stepN, sc.id(), sc.note(), url, tree);

                    // Tree content checks
                    assertContains(findings, sc.id(), tree, "Diff playground");
                    if (sc.id().equals("01_baseline")) {
                        assertContains(findings, sc.id(), tree, "collapsed");
                        assertContains(findings, sc.id(), tree, "Queue item");
                        assertContains(findings, sc.id(), tree, "Alpha");
                        assertContains(findings, sc.id(), tree, "Beta");
                        // options should not appear as open menu options lines when closed
                        if (tree.lines().anyMatch(l ->
                                l.trim().startsWith("- option \"")
                                        && (l.contains("Draft") || l.contains("In review") || l.contains("Shipped")))) {
                            findings.add(new Finding(sc.id(), "bug",
                                    "Menu options visible in tree while closed"));
                        }
                    }
                    if (sc.id().equals("02_menu_open")) {
                        assertContains(findings, sc.id(), tree, "expanded");
                        assertContains(findings, sc.id(), tree, "Draft");
                        assertContains(findings, sc.id(), tree, "In review");
                    }
                    if (sc.id().equals("03_count_plus2")) {
                        long queueLines = tree.lines()
                                .filter(l -> l.contains("listitem") && l.contains("Queue item"))
                                .count();
                        if (queueLines < 3) {
                            findings.add(new Finding(sc.id(), "bug",
                                    "Expected >=3 Queue item listitems, got " + queueLines));
                        }
                    }
                    if (sc.id().equals("04_swap")) {
                        // tree still has both buttons; order is validated via diff
                        assertContains(findings, sc.id(), tree, "Alpha");
                        assertContains(findings, sc.id(), tree, "Beta");
                    }
                    if (sc.id().equals("05_validate")) {
                        assertContains(findings, sc.id(), tree, "alert");
                        assertContains(findings, sc.id(), tree, "claim code is required");
                        assertContains(findings, sc.id(), tree, "invalid");
                    }
                    if (sc.id().equals("06_toast")) {
                        assertContains(findings, sc.id(), tree, "Diff lab toast");
                    }

                    // Diff vs previous (same as interactive NN_diff.md)
                    if (stepN > 1 && !lastTree.isBlank() && !tree.isBlank()) {
                        String diff = SnapshotCapture.simpleDiff(lastTree, tree);
                        String header = SnapshotCapture.diffHeader(stepN - 1, stepN, lastUrl, url);
                        Path diffPath = outDir.resolve(String.format("%02d_diff.md", stepN));
                        Files.writeString(diffPath, header + diff, StandardCharsets.UTF_8);
                        System.out.println("  wrote " + diffPath.getFileName()
                                + " (" + diff.lines().count() + " lines)");

                        checkDiffExpectations(findings, sc.id(), diff);
                    }

                    lastTree = tree;
                    lastUrl = url;
                    System.out.println("  tree lines=" + tree.lines().count());
                } catch (Exception e) {
                    findings.add(new Finding(sc.id(), "bug", "Step threw: " + e.getMessage()));
                    System.err.println("  ERROR: " + e.getMessage());
                    e.printStackTrace(System.err);
                }
            }
        } finally {
            driver.quit();
        }

        long bugs = findings.stream().filter(f -> "bug".equals(f.severity())).count();
        StringBuilder report = new StringBuilder();
        report.append("# Selenium Diff lab hunt report\n\n");
        report.append("- Base URL: ").append(base).append('\n');
        report.append("- Steps: ").append(stepN).append('\n');
        report.append("- Bugs: ").append(bugs).append('\n');
        report.append("- Output: ").append(outDir.toAbsolutePath()).append("\n\n");
        report.append("## Findings\n\n");
        if (findings.isEmpty()) {
            report.append("_No findings - trees and diffs look correct._\n\n");
        } else {
            for (Finding f : findings) {
                report.append("- **[").append(f.severity().toUpperCase()).append("]** `")
                        .append(f.step()).append("`: ").append(f.message()).append('\n');
            }
            report.append('\n');
        }
        report.append("## Expected diff signals\n\n");
        report.append("| Step | Expect in NN_diff.md |\n");
        report.append("|------|----------------------|\n");
        report.append("| 02_menu_open | Dropdown / options changes (Draft, In review, …) |\n");
        report.append("| 03_count_plus2 | Added listitem Queue item (count +2) |\n");
        report.append("| 04_swap | Reordered (Alpha/Beta) OR position shift |\n");
        report.append("| 05_validate | Added alert / invalid |\n");
        report.append("| 06_toast | Added toast / status text |\n\n");

        Path reportPath = outDir.resolve("DIFF_HUNT_REPORT.md");
        Files.writeString(reportPath, report.toString(), StandardCharsets.UTF_8);
        System.out.println("\n==== REPORT ====");
        System.out.println(report);
        System.out.println("Wrote " + reportPath.toAbsolutePath());

        if (bugs > 0) {
            System.exit(2);
        }
    }

    private static void checkDiffExpectations(List<Finding> findings, String stepId, String diff) {
        switch (stepId) {
            case "02_menu_open" -> {
                if (!diff.contains("Dropdown") && !diff.toLowerCase().contains("option")) {
                    findings.add(new Finding(stepId, "bug",
                            "Diff missing dropdown/options signal:\n" + clip(diff, 400)));
                }
                if (!diff.contains("Draft") && !diff.contains("In review") && !diff.contains("Shipped")) {
                    findings.add(new Finding(stepId, "bug",
                            "Diff missing menu option names (Draft/In review/Shipped)"));
                }
            }
            case "03_count_plus2" -> {
                long addedQueue = diff.lines()
                        .filter(l -> l.startsWith("+")
                                && l.contains("listitem")
                                && (l.contains("Queue item") || l.trim().equals("+ - listitem")))
                        .count();
                // Prefer named listitems; bare "+ - listitem" also counts after aria-label fix
                long named = diff.lines()
                        .filter(l -> l.startsWith("+") && l.contains("Queue item"))
                        .count();
                if (named < 2 && addedQueue < 2) {
                    findings.add(new Finding(stepId, "bug",
                            "Expected >=2 added Queue item / listitem lines in diff, got named="
                                    + named + " bare=" + addedQueue + "\n" + clip(diff, 400)));
                }
            }
            case "04_swap" -> {
                if (!diff.contains("Reordered")) {
                    findings.add(new Finding(stepId, "bug",
                            "Expected ## Reordered after Alpha/Beta swap:\n" + clip(diff, 300)));
                }
                if (!diff.contains("Alpha") && !diff.contains("Beta")) {
                    findings.add(new Finding(stepId, "bug",
                            "Reorder diff missing Alpha/Beta lines"));
                }
            }
            case "05_validate" -> {
                if (!diff.contains("alert") && !diff.contains("claim code")) {
                    findings.add(new Finding(stepId, "bug",
                            "Diff missing alert/claim code after validate:\n" + clip(diff, 400)));
                }
                if (!diff.contains("invalid")) {
                    findings.add(new Finding(stepId, "bug",
                            "Diff missing invalid field after validate"));
                }
            }
            case "06_toast" -> {
                if (!diff.contains("Diff lab toast") && !diff.toLowerCase().contains("toast")) {
                    findings.add(new Finding(stepId, "bug",
                            "Diff missing toast text:\n" + clip(diff, 400)));
                }
            }
            default -> {
            }
        }
    }

    private static String clip(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    private static void assertContains(List<Finding> findings, String step, String hay, String needle) {
        if (hay == null || !hay.contains(needle)) {
            findings.add(new Finding(step, "bug", "Tree missing \"" + needle + "\""));
        }
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

    private static void writeYaml(Path outDir, int step, String id, String note, String url, String tree)
            throws Exception {
        StringBuilder sb = new StringBuilder();
        sb.append("# URL: ").append(url).append('\n');
        sb.append("# Captured: ").append(Instant.now()).append('\n');
        sb.append("# Engine: selenium DiffLabHunt\n");
        sb.append("# Scenario: ").append(id).append('\n');
        sb.append("# Note: ").append(note).append('\n');
        sb.append("# Step: ").append(step).append('\n');
        sb.append('\n');
        sb.append(tree).append('\n');
        String file = String.format("%02d_%s.yaml", step, id);
        Files.writeString(outDir.resolve(file), sb.toString(), StandardCharsets.UTF_8);
        System.out.println("  -> " + file);
    }

    private static void loadChromeDriverFromConfig() throws Exception {
        Path cfg = Path.of("capture.config.properties");
        if (!Files.exists(cfg)) return;
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
}
