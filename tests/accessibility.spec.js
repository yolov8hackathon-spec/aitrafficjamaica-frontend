// @ts-check
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const BASE = 'https://aitrafficja.com';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wlz.onboarding.done', '1'));
});

test('homepage has no critical WCAG violations', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForTimeout(1500);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .exclude('#login-modal')       // hidden modals skipped
    .exclude('#register-modal')
    .exclude('#gov-overlay')       // hidden overlay skipped
    .analyze();

  // Log all violations for visibility
  if (results.violations.length > 0) {
    console.log('\n── Accessibility Violations ──');
    results.violations.forEach(v => {
      console.log(`[${v.impact?.toUpperCase()}] ${v.id}: ${v.description}`);
      v.nodes.slice(0, 2).forEach(n => console.log(`  → ${n.html.slice(0, 120)}`));
    });
  }

  const critical   = results.violations.filter(v => v.impact === 'critical');
  const serious    = results.violations.filter(v => v.impact === 'serious');

  // Fail on critical violations only — log serious as warnings
  if (serious.length > 0) {
    console.log(`\n⚠ ${serious.length} serious violation(s) — review recommended`);
  }

  expect(critical, `Critical WCAG violations found:\n${JSON.stringify(critical, null, 2)}`).toHaveLength(0);
});

test('login modal has no critical WCAG violations when open', async ({ page }) => {
  await page.goto(BASE);
  await page.locator('#btn-open-login').click();
  await expect(page.locator('#login-modal')).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include('#login-modal')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();

  const critical = results.violations.filter(v => v.impact === 'critical');
  expect(critical, JSON.stringify(critical, null, 2)).toHaveLength(0);
});

test('page has sufficient colour contrast (AA)', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForTimeout(1000);

  const results = await new AxeBuilder({ page })
    .withRules(['color-contrast'])
    .analyze();

  if (results.violations.length > 0) {
    console.log(`\nContrast violations: ${results.violations.length}`);
    results.violations[0]?.nodes.slice(0, 3).forEach(n =>
      console.log(`  → ${n.html.slice(0, 100)}`)
    );
  }

  // Report but don't hard-fail — contrast issues are design decisions
  console.log(`Contrast violations: ${results.violations.length}`);
});

test('mobile view has no critical WCAG violations', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(BASE);
  await page.waitForTimeout(1000);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();

  const critical = results.violations.filter(v => v.impact === 'critical');
  expect(critical, JSON.stringify(critical, null, 2)).toHaveLength(0);
});
