import org.openqa.selenium.By;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
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
 * Automated Snapshot Lab bug-hunt for the Selenium capture engine.
 *
 * Uses the same CAPTURE_TREE_JS as interactive SnapshotCapture.
 *
 * Usage (from pagesnap-selenium/):
 *   mvn -q compile exec:java -Dexec.mainClass=LabBugHunt -Dexec.args="http://localhost:4173"
 */
public class LabBugHunt {

    private static final DateTimeFormatter FOLDER_TS =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH-mm-ss").withZone(ZoneId.of("America/New_York"));

    private record Finding(String scenario, String severity, String message) {}

    private record Scenario(String id, String section, String note, String action, List<String> expect) {}

    public static void main(String[] args) throws Exception {
        SnapshotCapture.useUtf8Console();
        String base = args.length > 0 && !args[0].isBlank() ? args[0] : "http://localhost:4173";

        List<Scenario> scenarios = List.of(
                new Scenario("01_intro", "intro", "Intro panel", null, List.of("heading", "tablist")),
                new Scenario("02_forms_default", "forms", "Forms default", null,
                        List.of("textbox", "Password", "value: \"***\"", "checkbox", "radio", "disabled")),
                new Scenario("03_forms_validation", "forms", "Validation error", "validation",
                        List.of("alert", "invalid")),
                new Scenario("04_dropdowns_closed", "dropdowns", "Custom dropdown closed", null,
                        List.of("combobox", "listbox", "collapsed")),
                new Scenario("05_dropdowns_open", "dropdowns", "Custom dropdown open", "open-dropdown",
                        List.of("expanded", "North America")),
                new Scenario("06_modals_closed", "modals", "Modals closed", null,
                        List.of("Open CSS modal")),
                new Scenario("07_modals_css_open", "modals", "CSS modal open", "open-css-modal",
                        List.of("dialog")),
                new Scenario("08_modals_native_open", "modals", "Native dialog open", "open-native-dialog",
                        List.of("dialog")),
                new Scenario("09_shadow", "shadow", "Shadow DOM", null, List.of("button", "textbox")),
                new Scenario("10_iframe", "iframe", "Iframe", null, List.of("iframe")),
                new Scenario("11_tabs", "tabs", "New tab launcher", null, List.of("button")),
                new Scenario("12_table", "table", "Table dump", null, List.of("table", "headers:")),
                new Scenario("13_misc", "misc", "Misc roles", null, List.of("progressbar", "switch")),
                // Phase-1 benchmark sections (shared with pagesnap-playwright / playwright lab)
                new Scenario("14_bench_redact", "bench-redact", "Bench redaction secrets prefilled", null,
                        List.of("textbox", "API password", "***")),
                new Scenario("15_bench_redact_toast", "bench-redact", "Bench redaction secret toast", "bench-redact-submit",
                        List.of("alert", "***")),
                new Scenario("16_bench_dup_names", "bench-dup-names", "Bench duplicate Save buttons", null,
                        List.of("Save", "Display name", "Region Alpha")),
                new Scenario("17_bench_nest_frame", "bench-nest-frame", "Bench nested iframes", "wait-frames",
                        List.of("iframe", "Parent page field", "INNER-42")),
                new Scenario("18_bench_role_soup", "bench-role-soup", "Bench role soup", null,
                        List.of("progressbar", "table", "Composite control")),
                new Scenario("19_bench_role_soup_alert", "bench-role-soup", "Bench role soup alert", "bench-role-validate",
                        List.of("alert", "already used")),
                new Scenario("20_bench_acc_alerts", "bench-accuracy", "Bench accuracy: in-tree alerts", null,
                        List.of("- alert \"Card number is invalid — use 16 digits.\"",
                                "error: \"ZIP code must be 5 digits.\"",
                                "region \"Payment\"",
                                "- alert \"Wrapped error stays visible.\"")),
                new Scenario("21_bench_dup_qualifiers", "bench-dup-names", "Bench dup: ancestry qualifiers", null,
                        List.of("in=\"Region Alpha\"", "in=\"Region Beta\"", "in=\"Region Gamma\"")),
                new Scenario("22_bench_acc_dup_ordinal", "bench-accuracy", "Bench accuracy: ordinal fallback", null,
                        List.of("dup 1/2", "dup 2/2")),
                new Scenario("23_bench_acc_truncation", "bench-accuracy", "Bench accuracy: truncation markers", null,
                        List.of("(subtree truncated at depth 30)", "more hints truncated"))
        );

        String stamp = FOLDER_TS.format(Instant.now());
        Path outDir = Path.of("pageSnapshots", "session-lab-bug-hunt-se-" + stamp);
        Files.createDirectories(outDir);

        List<Finding> findings = new ArrayList<>();
        ChromeOptions options = new ChromeOptions();
        options.addArguments("--headless=new", "--window-size=1400,900", "--disable-gpu");
        // Prefer local driver path from config if present
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

        WebDriver driver = new ChromeDriver(options);
        JavascriptExecutor js = (JavascriptExecutor) driver;
        System.out.println("Lab bug-hunt (Selenium engine)");
        System.out.println("  Base URL: " + base);
        System.out.println("  Output: " + outDir.toAbsolutePath());

        try {
            driver.get(base);
            new WebDriverWait(driver, Duration.ofSeconds(15))
                    .until(d -> d.findElement(By.id("tab-intro")).isDisplayed());

            int step = 0;
            for (Scenario sc : scenarios) {
                step++;
                System.out.printf("%n[%d/%d] %s: %s%n", step, scenarios.size(), sc.id(), sc.note());
                try {
                    selectSection(driver, sc.section());
                    runAction(driver, sc.action());
                    Thread.sleep(200);

                    Map<String, Object> opts = new LinkedHashMap<>();
                    opts.put("maxTableRows", 5);
                    opts.put("redactPasswords", true);
                    opts.put("redactEmails", true);

                    Object result = js.executeScript(SnapshotCapture.CAPTURE_TREE_JS, opts);
                    String tree = "";
                    List<String> hints = new ArrayList<>();
                    if (result instanceof Map<?, ?> map) {
                        Object t = map.get("tree");
                        tree = t != null ? t.toString() : "";
                        Object h = map.get("hints");
                        if (h instanceof List<?> list) {
                            for (Object item : list) {
                                if (item != null) hints.add(item.toString());
                            }
                        }
                    } else if (result != null) {
                        tree = result.toString();
                    }

                    if (tree.isBlank()) {
                        findings.add(new Finding(sc.id(), "bug", "EMPTY custom ARIA tree"));
                    }
                    String hintBlob = String.join("\n", hints);
                    for (String exp : sc.expect()) {
                        if (!tree.contains(exp) && !hintBlob.contains(exp)) {
                            findings.add(new Finding(sc.id(), "bug", "Missing expected: \"" + exp + "\""));
                        }
                    }
                    if (sc.section().equals("forms") && tree.matches("(?s).*secret123.*")) {
                        findings.add(new Finding(sc.id(), "bug", "Password not redacted"));
                    }
                    if (sc.section().equals("bench-redact")) {
                        if (tree.contains("super-secret-99")) {
                            findings.add(new Finding(sc.id(), "bug", "Bench password secret leaked"));
                        }
                        if (tree.contains("agent@secret.example")) {
                            findings.add(new Finding(sc.id(), "bug", "Bench email secret leaked"));
                        }
                    }
                    if (sc.id().equals("04_dropdowns_closed")) {
                        boolean openOpt = tree.lines().anyMatch(l ->
                                l.trim().startsWith("- option \"")
                                        && (l.contains("North America") || l.contains("Europe") || l.contains("Asia Pacific")));
                        if (openOpt) {
                            findings.add(new Finding(sc.id(), "bug",
                                    "Custom dropdown options visible in tree while closed"));
                        }
                    }
                    if (tree.contains("__snapshot_toolbar") || tree.contains("data-snapshot-tool")) {
                        findings.add(new Finding(sc.id(), "bug", "Injected chrome leaked into tree"));
                    }
                    if (tree.contains("# --- Visible alerts / errors ---")) {
                        findings.add(new Finding(sc.id(), "bug", "Legacy alerts footer still emitted"));
                    }

                    StringBuilder yaml = new StringBuilder();
                    yaml.append("# URL: ").append(driver.getCurrentUrl()).append('\n');
                    yaml.append("# Captured: ").append(Instant.now()).append('\n');
                    yaml.append("# Engine: selenium CAPTURE_TREE_JS\n");
                    yaml.append("# Scenario: ").append(sc.id()).append('\n');
                    yaml.append("# Note: ").append(sc.note()).append('\n');
                    yaml.append("# Step: ").append(step).append('\n');
                    yaml.append('\n');
                    yaml.append(tree).append('\n');
                    if (!hints.isEmpty()) {
                        yaml.append("\n# --- Selenium hints ---\n");
                        for (String h : hints) {
                            yaml.append("# ").append(h.replaceFirst("^//\\s*", "")).append('\n');
                        }
                    }

                    String file = String.format("%02d_%s.yaml", step, sc.id());
                    Files.writeString(outDir.resolve(file), yaml.toString(), StandardCharsets.UTF_8);
                    long lines = tree.isBlank() ? 0 : tree.lines().count();
                    System.out.println("  tree lines=" + lines + " -> " + file);
                } catch (Exception e) {
                    findings.add(new Finding(sc.id(), "bug", "Scenario threw: " + e.getMessage()));
                    System.err.println("  ERROR: " + e.getMessage());
                    e.printStackTrace(System.err);
                }
            }
        } finally {
            driver.quit();
        }

        long bugs = findings.stream().filter(f -> "bug".equals(f.severity())).count();
        long warns = findings.stream().filter(f -> "warn".equals(f.severity())).count();
        StringBuilder report = new StringBuilder();
        report.append("# Selenium lab bug-hunt report\n\n");
        report.append("- Base URL: ").append(base).append('\n');
        report.append("- Scenarios: ").append(scenarios.size()).append('\n');
        report.append("- Bugs: ").append(bugs).append('\n');
        report.append("- Warnings: ").append(warns).append('\n');
        report.append("- Output: ").append(outDir.toAbsolutePath()).append("\n\n");
        report.append("## Findings\n\n");
        if (findings.isEmpty()) {
            report.append("_No findings - all expectations met._\n\n");
        } else {
            for (Finding f : findings) {
                report.append("- **[").append(f.severity().toUpperCase()).append("]** `")
                        .append(f.scenario()).append("`: ").append(f.message()).append('\n');
            }
            report.append('\n');
        }
        report.append("## Scenario checklist\n\n");
        for (Scenario sc : scenarios) {
            boolean hasBug = findings.stream().anyMatch(f -> f.scenario().equals(sc.id()) && "bug".equals(f.severity()));
            boolean hasWarn = findings.stream().anyMatch(f -> f.scenario().equals(sc.id()) && "warn".equals(f.severity()));
            String status = hasBug ? "FAIL" : hasWarn ? "WARN" : "OK";
            report.append("- [").append(status).append("] ").append(sc.id()).append(" - ").append(sc.note()).append('\n');
        }
        report.append('\n');

        Path reportPath = outDir.resolve("BUG_HUNT_REPORT.md");
        Files.writeString(reportPath, report.toString(), StandardCharsets.UTF_8);
        System.out.println("\n==== REPORT ====");
        System.out.println(report);
        System.out.println("Wrote " + reportPath.toAbsolutePath());

        if (bugs > 0) {
            System.exit(2);
        }
    }

    private static void dismissOverlays(WebDriver driver) {
        JavascriptExecutor js = (JavascriptExecutor) driver;
        js.executeScript(
                "var d=document.getElementById('native-dialog');"
                        + "if(d&&d.open)d.close();"
                        + "var c=document.getElementById('css-modal-close');"
                        + "if(c)c.click();"
                        + "var b=document.getElementById('css-modal');"
                        + "if(b){b.classList.add('hidden');b.setAttribute('hidden','');}");
        try {
            Thread.sleep(100);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static void selectSection(WebDriver driver, String id) {
        dismissOverlays(driver);
        JavascriptExecutor js = (JavascriptExecutor) driver;
        // JS click avoids modal-backdrop intercepting Selenium's element click
        js.executeScript("document.getElementById(arguments[0]).click();", "tab-" + id);
        try {
            Thread.sleep(200);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static void runAction(WebDriver driver, String action) {
        if (action == null) return;
        JavascriptExecutor js = (JavascriptExecutor) driver;
        switch (action) {
            case "validation" -> driver.findElement(By.id("show-validation")).click();
            case "open-dropdown" -> driver.findElement(By.id("region-trigger")).click();
            case "open-css-modal" -> driver.findElement(By.id("open-css-modal")).click();
            case "open-native-dialog" -> {
                dismissOverlays(driver);
                selectSection(driver, "modals");
                driver.findElement(By.id("open-native-dialog")).click();
            }
            case "bench-redact-submit" -> driver.findElement(By.id("bench-redact-submit")).click();
            case "bench-role-validate" -> driver.findElement(By.id("bench-role-validate")).click();
            case "wait-frames" -> {
                try {
                    Thread.sleep(800);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            default -> {
            }
        }
        try {
            Thread.sleep(150);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
