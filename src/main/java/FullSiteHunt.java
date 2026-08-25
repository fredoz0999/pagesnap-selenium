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

/** Generated full-site hunt — all test-site sections. Headless. */
public class FullSiteHunt {
    private static final DateTimeFormatter FOLDER_TS =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH-mm-ss").withZone(ZoneId.of("America/New_York"));
    private record Case(String id, String section, String note, String action, List<String> expect) {}
    private record Finding(String scenario, String severity, String message) {}

    public static void main(String[] args) throws Exception {
        SnapshotCapture.useUtf8Console();
        String base = args.length > 0 && !args[0].isBlank() ? args[0] : "http://localhost:4173";
        List<Case> cases = List.of(
                new Case("01_intro", "intro", "Intro / how-to", null, List.of("Snapshot Lab", "tablist")),
                new Case("02_forms_default", "forms", "Forms default", null, List.of("Username", "Password", "***")),
                new Case("03_forms_validation", "forms", "Forms validation error", "validation", List.of("alert", "already exists")),
                new Case("04_complex_forms", "complex-forms", "Complex forms", null, List.of("Complex", "country", "tag", "form")),
                new Case("05_dropdowns_closed", "dropdowns", "Dropdowns closed", null, List.of("combobox", "listbox")),
                new Case("06_dropdowns_open", "dropdowns", "Dropdowns open", "open-dropdown", List.of("option", "North America")),
                new Case("07_modals_closed", "modals", "Modals closed", null, List.of("Open CSS modal")),
                new Case("08_modals_css", "modals", "CSS modal open", "open-css-modal", List.of("dialog")),
                new Case("09_modals_native", "modals", "Native dialog open", "open-native-dialog", List.of("dialog")),
                new Case("10_overlays", "overlays", "Overlays default", null, List.of("popover", "drawer", "button")),
                new Case("11_overlays_drawer", "overlays", "Overlays drawer open", "open-drawer-overlay", List.of("button")),
                new Case("12_shadow", "shadow", "Shadow DOM", null, List.of("textbox", "button")),
                new Case("13_iframe", "iframe", "Iframe", null, List.of("iframe")),
                new Case("14_tabs", "tabs", "New tab launcher", null, List.of("button", "tab")),
                new Case("15_table", "table", "Static table", null, List.of("table", "1001")),
                new Case("16_dyn_table", "dyn-table", "Dynamic table", null, List.of("table", "button", "Account")),
                new Case("17_virtual", "virtual", "Virtual list", null, List.of("button", "Select")),
                new Case("18_async", "async", "Async list default", null, List.of("button", "Load")),
                new Case("19_async_load", "async", "Async list after load", "async-load", List.of("button")),
                new Case("20_wizard", "wizard", "Wizard step 1", null, List.of("Wizard", "Email", "button")),
                new Case("21_search", "search", "Live search", null, List.of("search", "listbox", "button")),
                new Case("22_search_type", "search", "Live search typed", "search-type", List.of("listbox", "option")),
                new Case("23_shell", "shell", "App shell", null, List.of("button", "Dashboard", "Console")),
                new Case("24_collab", "collab", "Live collab", null, List.of("button", "Like", "viewing")),
                new Case("25_permissions", "permissions", "Permissions", null, List.of("button", "ready", "empty")),
                new Case("26_charts", "charts", "Charts & media", null, List.of("chart", "table", "button")),
                new Case("27_misc", "misc", "Misc roles", null, List.of("progressbar", "switch")),
                new Case("28_diff_baseline", "diff-lab", "Diff playground baseline", null, List.of("Diff playground", "Queue item", "Alpha")),
                new Case("29_diff_menu_open", "diff-lab", "Diff menu open", "diff-menu", List.of("Draft", "In review")),
                new Case("30_diff_add", "diff-lab", "Diff add items", "diff-add", List.of("Queue item")),
                new Case("31_diff_swap", "diff-lab", "Diff swap order", "diff-swap", List.of("Alpha", "Beta")),
                new Case("32_diff_validate", "diff-lab", "Diff validate alert", "diff-validate", List.of("alert", "claim code")),
                new Case("33_diff_toast", "diff-lab", "Diff toast", "diff-toast", List.of("toast")),
                new Case("34_realworld_inbox", "realworld", "Real-world inbox ready", null, List.of("Acme Corp", "T-1042", "Ticket")),
                new Case("35_realworld_filter", "realworld", "Real-world filter P1", "rw-filter-p1", List.of("P1", "T-")),
                new Case("36_realworld_confirm", "realworld", "Real-world bulk confirm", "rw-confirm", List.of("dialog", "Confirm", "Close")),
                new Case("37_realworld_drawer", "realworld", "Real-world drawer", "rw-drawer", List.of("Quick filters", "dialog")),
                new Case("38_realworld_loading", "realworld", "Real-world loading state", "rw-loading", List.of("Loading", "status")),
                new Case("39_realworld_error", "realworld", "Real-world error state", "rw-error", List.of("alert", "Failed", "Retry")),
                new Case("40_bench_redact", "bench-redact", "Bench redaction fields", null, List.of("API password", "***")),
                new Case("41_bench_redact_toast", "bench-redact", "Bench redaction toast", "bench-redact-submit", List.of("alert", "***")),
                new Case("42_bench_dup_names", "bench-dup-names", "Bench dup names", null, List.of("Save", "Region Alpha", "Display name")),
                new Case("43_bench_nest_frame", "bench-nest-frame", "Bench nest frames", null, List.of("iframe", "PARENT-OK", "INNER-42")),
                new Case("44_bench_role_soup", "bench-role-soup", "Bench role soup", null, List.of("progressbar", "table", "Composite control")),
                new Case("45_bench_role_alert", "bench-role-soup", "Bench role soup alert", "bench-role-validate", List.of("alert", "already used")),
                new Case("46_bench_accuracy", "bench-accuracy", "Bench accuracy", null, List.of("alert", "Copy link")),
                new Case("47_bench_dyn_attrs", "bench-dyn-attrs", "Bench dynamic attrs baseline", null, List.of("Reseed attributes", "Run search", "Dynamic")),
                new Case("48_bench_dyn_reseed", "bench-dyn-attrs", "Bench dynamic attrs after reseed", "dyn-reseed", List.of("Run search", "Reseed attributes", "seed"))
        );
        String stamp = FOLDER_TS.format(Instant.now());
        Path outDir = Path.of("pageSnapshots", "session-full-site-se-" + stamp);
        Files.createDirectories(outDir);
        List<Finding> findings = new ArrayList<>();
        ChromeOptions options = new ChromeOptions();
        options.addArguments("--headless=new", "--window-size=1400,900", "--disable-gpu");
        WebDriver driver = new ChromeDriver(options);
        JavascriptExecutor js = (JavascriptExecutor) driver;
        System.out.println("Full-site hunt (Selenium headless)");
        System.out.println("  Base: " + base);
        System.out.println("  Out:  " + outDir.toAbsolutePath());
        System.out.println("  Cases: " + cases.size());
        try {
            driver.get(base);
            new WebDriverWait(driver, Duration.ofSeconds(20))
                    .until(d -> d.findElement(By.id("tab-intro")).isDisplayed());
            int step = 0;
            for (Case sc : cases) {
                step++;
                System.out.printf("%n[%d/%d] %s%n", step, cases.size(), sc.id());
                try {
                    dismiss(driver);
                    js.executeScript("document.getElementById(arguments[0]).click();", "tab-" + sc.section());
                    Thread.sleep(300);
                    runAction(driver, sc.action());
                    Thread.sleep(200);
                    Map<String, Object> opts = new LinkedHashMap<>();
                    opts.put("maxTableRows", 5);
                    opts.put("redactPasswords", true);
                    opts.put("redactEmails", true);
                    Object result = js.executeScript(SnapshotCapture.CAPTURE_TREE_JS, opts);
                    String tree = "";
                    if (result instanceof Map<?, ?> map && map.get("tree") != null) tree = map.get("tree").toString();
                    if (tree.isBlank()) findings.add(new Finding(sc.id(), "bug", "EMPTY tree"));
                    for (String exp : sc.expect()) {
                        if (!tree.toLowerCase().contains(exp.toLowerCase()) && !tree.contains(exp)) {
                            findings.add(new Finding(sc.id(), "bug", "Missing: " + exp));
                        }
                    }
                    if (tree.contains("super-secret-99") || tree.contains("agent@secret.example")) {
                        findings.add(new Finding(sc.id(), "bug", "Secret leak"));
                    }
                    StringBuilder yaml = new StringBuilder();
                    yaml.append("# Engine: selenium CAPTURE_TREE_JS\n");
                    yaml.append("# Scenario: ").append(sc.id()).append("\n");
                    yaml.append("# Note: ").append(sc.note()).append("\n\n");
                    yaml.append(tree).append("\n");
                    Files.writeString(outDir.resolve(String.format("%02d_%s.yaml", step, sc.id())),
                            yaml.toString(), StandardCharsets.UTF_8);
                    System.out.println("  lines=" + tree.lines().count());
                } catch (Exception e) {
                    findings.add(new Finding(sc.id(), "bug", e.getMessage()));
                    System.err.println("  ERROR " + e.getMessage());
                }
            }
        } finally {
            driver.quit();
        }
        long bugs = findings.stream().filter(f -> "bug".equals(f.severity())).count();
        StringBuilder report = new StringBuilder();
        report.append("# Full-site Selenium report\n\n");
        report.append("- Cases: ").append(cases.size()).append("\n");
        report.append("- Bugs: ").append(bugs).append("\n");
        report.append("- Output: ").append(outDir.toAbsolutePath()).append("\n\n");
        for (Finding f : findings) {
            report.append("- **[").append(f.severity()).append("]** `").append(f.scenario()).append("`: ")
                    .append(f.message()).append("\n");
        }
        for (Case sc : cases) {
            boolean fail = findings.stream().anyMatch(f -> f.scenario().equals(sc.id()) && "bug".equals(f.severity()));
            report.append("- [").append(fail ? "FAIL" : "OK").append("] ").append(sc.id()).append("\n");
        }
        Files.writeString(outDir.resolve("FULL_SITE_REPORT.md"), report.toString(), StandardCharsets.UTF_8);
        System.out.println(report);
        if (bugs > 0) System.exit(2);
    }

    private static void dismiss(WebDriver driver) {
        ((JavascriptExecutor) driver).executeScript(
                "var d=document.getElementById('native-dialog');if(d&&d.open)d.close();"
                        + "var c=document.getElementById('css-modal-close');if(c)c.click();"
                        + "var b=document.getElementById('css-modal');if(b){b.classList.add('hidden');b.setAttribute('hidden','');}"
                        + "var n=document.getElementById('rw-confirm-no');if(n)n.click();"
                        + "var r=document.getElementById('rw-drawer-close');if(r)r.click();");
        try { Thread.sleep(80); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    private static void runAction(WebDriver driver, String action) throws Exception {
        if (action == null) return;
        JavascriptExecutor js = (JavascriptExecutor) driver;
        switch (action) {
            case "validation" -> driver.findElement(By.id("show-validation")).click();
            case "open-dropdown" -> driver.findElement(By.id("region-trigger")).click();
            case "open-css-modal" -> driver.findElement(By.id("open-css-modal")).click();
            case "open-native-dialog" -> {
                dismiss(driver);
                js.executeScript("document.getElementById('tab-modals').click();");
                Thread.sleep(200);
                driver.findElement(By.id("open-native-dialog")).click();
            }
            case "open-drawer-overlay" -> {
                try { driver.findElement(By.id("open-drawer")).click(); } catch (Exception ignored) {}
            }
            case "async-load" -> {
                try { driver.findElement(By.id("async-load")).click(); Thread.sleep(600); } catch (Exception ignored) {}
            }
            case "search-type" -> {
                try {
                    var el = driver.findElement(By.id("live-search-input"));
                    el.clear(); el.sendKeys("a"); Thread.sleep(250);
                } catch (Exception ignored) {}
            }
            case "diff-menu" -> driver.findElement(By.id("diff-status-trigger")).click();
            case "diff-add" -> {
                Object open = js.executeScript(
                        "var b=document.getElementById('diff-status-trigger');return b&&b.getAttribute('aria-expanded')==='true';");
                if (Boolean.TRUE.equals(open)) driver.findElement(By.id("diff-status-trigger")).click();
                driver.findElement(By.id("diff-add-item")).click();
                driver.findElement(By.id("diff-add-item")).click();
            }
            case "diff-swap" -> driver.findElement(By.id("diff-swap")).click();
            case "diff-validate" -> driver.findElement(By.id("diff-validate")).click();
            case "diff-toast" -> driver.findElement(By.id("diff-show-toast")).click();
            case "rw-filter-p1" -> {
                var sel = driver.findElement(By.id("rw-filter-priority"));
                sel.findElement(By.cssSelector("option[value=P1]")).click();
            }
            case "rw-confirm" -> {
                try {
                    driver.findElement(By.id("rw-filter-priority")).findElement(By.cssSelector("option[value=all]")).click();
                } catch (Exception ignored) {}
                driver.findElement(By.id("rw-select-all")).click();
                driver.findElement(By.id("rw-bulk-close")).click();
            }
            case "rw-drawer" -> {
                try { driver.findElement(By.id("rw-confirm-no")).click(); } catch (Exception ignored) {}
                driver.findElement(By.id("rw-open-drawer")).click();
            }
            case "rw-loading" -> {
                try { driver.findElement(By.id("rw-drawer-close")).click(); } catch (Exception ignored) {}
                driver.findElement(By.id("rw-sim-loading")).click();
                Thread.sleep(100);
            }
            case "rw-error" -> {
                Thread.sleep(1000);
                driver.findElement(By.id("rw-sim-error")).click();
            }
            case "bench-redact-submit" -> driver.findElement(By.id("bench-redact-submit")).click();
            case "bench-role-validate" -> driver.findElement(By.id("bench-role-validate")).click();
            case "wait-frames" -> Thread.sleep(900);
            case "dyn-reseed" -> driver.findElement(By.id("dyn-reseed")).click();
            default -> {}
        }
        Thread.sleep(150);
    }
}
