import asyncio
from playwright import async_api
from playwright.async_api import expect
async def run_test():
    pw = None; browser = None; context = None
    try:
        pw = await async_api.async_playwright().start()
        browser = await pw.chromium.launch(headless=True, args=["--window-size=1280,720","--disable-dev-shm-usage","--ipc=host","--single-process"])
        context = await browser.new_context()
        context.set_default_timeout(5000)
        await context.add_init_script("localStorage.setItem('wlz.onboarding.done', '1')")
        page = await context.new_page()
        await page.goto("http://localhost:5173/", wait_until="commit", timeout=10000)
        await page.wait_for_timeout(3000)
        await expect(page.locator('#fps-overlay')).to_be_attached(timeout=3000)
        await expect(page.locator('#count-widget').first).to_be_visible(timeout=3000)
    finally:
        if context: await context.close()
        if browser: await browser.close()
        if pw: await pw.stop()
asyncio.run(run_test())
