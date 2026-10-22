import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Unit tests for the parts of the capture tool that do not need a browser:
 * argument handling, cookie parsing, diffing and session naming.
 */
class SnapshotCaptureTest {

    private static Path writeConfig(String body) throws IOException {
        Path dir = Files.createTempDirectory("ps-config-");
        Path file = dir.resolve("capture.config.properties");
        Files.writeString(file, body, StandardCharsets.UTF_8);
        return file;
    }

    // --- argument / config precedence ---------------------------------------

    @Test
    void flagBeatsConfigFileWhateverTheOrder() throws IOException {
        Path cfg = writeConfig("goal=from file\nmaxTableRows=99\n");

        SnapshotCapture first = new SnapshotCapture();
        first.parseArgs(new String[] { "https://app.test", "--goal=from flag", "--config=" + cfg });
        assertEquals("from flag", first.goal);
        assertEquals(99, first.maxTableRows);

        SnapshotCapture second = new SnapshotCapture();
        second.parseArgs(new String[] { "https://app.test", "--config=" + cfg, "--goal=from flag" });
        assertEquals("from flag", second.goal);
    }

    @Test
    void configFileSuppliesWhatNoFlagSets() throws IOException {
        Path cfg = writeConfig("goal=from file\nmaxTableRows=7\n");
        SnapshotCapture c = new SnapshotCapture();
        c.parseArgs(new String[] { "https://app.test", "--config=" + cfg });
        assertEquals("from file", c.goal);
        assertEquals(7, c.maxTableRows);
    }

    @Test
    void badMaxTableRowsFallsBackInsteadOfCrashing() {
        SnapshotCapture c = new SnapshotCapture();
        c.parseArgs(new String[] { "https://app.test", "--max-table-rows=abc" });
        assertEquals(5, c.maxTableRows);
    }

    @Test
    void badMaxTableRowsInConfigFallsBack() throws IOException {
        Path cfg = writeConfig("maxTableRows=not-a-number\n");
        SnapshotCapture c = new SnapshotCapture();
        c.parseArgs(new String[] { "https://app.test", "--config=" + cfg });
        assertEquals(5, c.maxTableRows);
    }

    // --- timezone ------------------------------------------------------------

    @Test
    void sessionTimestampFollowsTheConfiguredTimezone() {
        Instant noon = Instant.parse("2026-07-27T16:30:45Z");
        assertEquals("2026-07-27T16-30-45", SnapshotCapture.sessionFolderTs(noon, "UTC"));
        assertEquals("2026-07-27T12-30-45", SnapshotCapture.sessionFolderTs(noon, "America/New_York"));
        assertEquals("2026-07-28T01-30-45", SnapshotCapture.sessionFolderTs(noon, "Asia/Tokyo"));
    }

    @Test
    void unknownTimezoneFallsBackToNewYork() {
        Instant noon = Instant.parse("2026-07-27T16:30:45Z");
        assertEquals("2026-07-27T12-30-45", SnapshotCapture.sessionFolderTs(noon, "Not/AZone"));
    }

    @Test
    void timezoneComesFromFlagAndConfig() throws IOException {
        SnapshotCapture flagged = new SnapshotCapture();
        flagged.parseArgs(new String[] { "https://app.test", "--timezone=UTC" });
        assertEquals("UTC", flagged.timezone);

        Path cfg = writeConfig("timezone=Europe/Berlin\n");
        SnapshotCapture configured = new SnapshotCapture();
        configured.parseArgs(new String[] { "https://app.test", "--config=" + cfg });
        assertEquals("Europe/Berlin", configured.timezone);

        assertEquals("America/New_York", new SnapshotCapture().timezone);
    }

    // --- cookie parsing ------------------------------------------------------

    @Test
    void readsASeleniumStyleCookieArray() {
        String raw = "[{\"name\":\"JSESSIONID\",\"value\":\"abc123\",\"domain\":\"bank.test\",\"secure\":true},"
                + "{\"name\":\"theme\",\"value\":\"dark\",\"expiry\":1893456000}]";
        List<Map<String, String>> cookies = SnapshotCapture.parseCookieJson(raw);
        assertEquals(2, cookies.size());
        assertEquals("abc123", cookies.get(0).get("value"));
        assertEquals("true", cookies.get(0).get("secure"));
        assertEquals("1893456000", cookies.get(1).get("expiry"));
    }

    @Test
    void keepsCookiesThatCarryNestedObjects() {
        String raw = "[{\"name\":\"session\",\"value\":\"v1\",\"meta\":{\"issuedBy\":\"sso\"}},"
                + "{\"name\":\"after\",\"value\":\"v2\"}]";
        List<Map<String, String>> cookies = SnapshotCapture.parseCookieJson(raw);
        assertEquals(List.of("session", "after"), cookies.stream().map(c -> c.get("name")).toList());
        assertEquals("v1", cookies.get(0).get("value"));
    }

    @Test
    void keepsBracesInsideACookieValue() {
        String raw = "[{\"name\":\"payload\",\"value\":\"{\\\"a\\\":1}\"}]";
        List<Map<String, String>> cookies = SnapshotCapture.parseCookieJson(raw);
        assertEquals(1, cookies.size());
        assertEquals("{\"a\":1}", cookies.get(0).get("value"));
    }

    @Test
    void ignoresEntriesWithoutAName() {
        String raw = "[{\"value\":\"orphan\"},{\"name\":\"ok\",\"value\":\"v\"}]";
        List<Map<String, String>> cookies = SnapshotCapture.parseCookieJson(raw);
        assertEquals(List.of("ok"), cookies.stream().map(c -> c.get("name")).toList());
    }

    // --- diffing -------------------------------------------------------------

    @Test
    void diffReportsAddedAndRemovedLines() {
        String out = SnapshotCapture.simpleDiff("- button \"Save\"\n- textbox \"Email\"",
                "- button \"Save\"\n- link \"Help\"");
        assertTrue(out.contains("## Added"), out);
        assertTrue(out.contains("+ - link \"Help\""), out);
        assertTrue(out.contains("## Removed"), out);
        assertTrue(out.contains("- - textbox \"Email\""), out);
    }

    @Test
    void diffSaysSoWhenNothingChanged() {
        assertTrue(SnapshotCapture.simpleDiff("- button \"Save\"", "- button \"Save\"")
                .contains("_No structural line changes detected._"));
    }

    @Test
    void diffCountsRepeatedLinesInsteadOfCollapsingThem() {
        String before = "- listitem \"Item\"";
        String after = "- listitem \"Item\"\n- listitem \"Item\"\n- listitem \"Item\"";
        long added = SnapshotCapture.simpleDiff(before, after).lines()
                .filter(l -> l.equals("+ - listitem \"Item\"")).count();
        assertEquals(2, added);
    }

    @Test
    void diffReportsRowsDroppingOutOfARepeatedList() {
        String before = "- row \"a\"\n- row \"a\"\n- row \"a\"";
        long removed = SnapshotCapture.simpleDiff(before, "- row \"a\"").lines()
                .filter(l -> l.equals("- - row \"a\"")).count();
        assertEquals(2, removed);
    }

    @Test
    void diffFlagsReorderingRatherThanClaimingNothingChanged() {
        String out = SnapshotCapture.simpleDiff("- button \"One\"\n- button \"Two\"",
                "- button \"Two\"\n- button \"One\"");
        assertFalse(out.contains("_No structural line changes detected._"), out);
        assertTrue(out.contains("Reordered"), out);
    }

    @Test
    void diffKeepsDropdownChangesInTheirOwnSection() {
        String out = SnapshotCapture.simpleDiff("- combobox \"State\"",
                "- combobox \"State\"\n- option \"Alaska\"");
        assertTrue(out.contains("## Dropdown / options changes"), out);
        assertTrue(out.contains("+ - option \"Alaska\""), out);
    }

    @Test
    void diffHeaderNamesTheUrlEachStepCameFrom() {
        String head = SnapshotCapture.diffHeader(1, 2, "https://app.test/login", "https://app.test/home");
        assertTrue(head.contains("# Diff step 1 -> 2") || head.contains("# Diff step 1"), head);
        assertTrue(head.contains("https://app.test/login"), head);
        assertTrue(head.contains("https://app.test/home"), head);
    }

    @Test
    void diffHeaderSaysWhenBothStepsSharedAUrl() {
        String head = SnapshotCapture.diffHeader(2, 3, "https://app.test/x", "https://app.test/x");
        assertTrue(head.contains("same URL"), head);
    }

    // --- naming --------------------------------------------------------------

    @Test
    void sanitizeUrlStripsJsessionidAndFlattensThePath() {
        assertEquals("bank.test_app_index.htm",
                SnapshotCapture.sanitizeUrl("https://bank.test/app;jsessionid=ABC123/index.htm"));
        assertEquals("bank.test_root", SnapshotCapture.sanitizeUrl("https://bank.test/"));
    }

    @Test
    void alertTreeNodesDiffAsOrdinaryAddedLines() {
        String before = "- textbox \"Email\"";
        String after = "- textbox \"Email\" [invalid]\n- alert \"Email is required.\"";
        String out = SnapshotCapture.simpleDiff(before, after);
        assertTrue(out.contains("## Added"), out);
        assertTrue(out.contains("+ - alert \"Email is required.\""), out);
    }

    // --- note normalization / duplicate captures -------------------------------

    @Test
    void normalizeNoteCollapsesDoubledPrefixAndGluedPrefixes() {
        assertEquals("action: click login", SnapshotCapture.normalizeNote("action: action: click login"));
        assertEquals("step 2 assert: cart shows 1", SnapshotCapture.normalizeNote("step 2assert: cart shows 1"));
        assertEquals("", SnapshotCapture.normalizeNote(null));
    }

    @Test
    void normalizeNoteCollapsesAccidentalDoubleText() {
        assertEquals("add to cart", SnapshotCapture.normalizeNote("add to cartadd to cart"));
    }

    @Test
    void duplicateCaptureNeedsSameUrlSameNoteInsideWindow() {
        assertTrue(SnapshotCapture.isDuplicateCapture(1000, "u", "n", 1000 + 2499, "u", "n"));
        assertFalse(SnapshotCapture.isDuplicateCapture(1000, "u", "n", 1000 + 2500, "u", "n"));
        assertFalse(SnapshotCapture.isDuplicateCapture(1000, "u", "n", 1100, "u2", "n"));
        assertFalse(SnapshotCapture.isDuplicateCapture(1000, "u", "n", 1100, "u", "other"));
        assertFalse(SnapshotCapture.isDuplicateCapture(0, null, null, 10, "u", "n"));
    }
}
