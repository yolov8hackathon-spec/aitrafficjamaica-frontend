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
        await page.locator('xpath=/html/body/main/aside/div/button[3]').nth(0).click(timeout=5000)
        await page.wait_for_timeout(1000)
        chat_input = page.locator('#chat-input')
        await chat_input.wait_for(state="visible", timeout=5000)
        await chat_input.fill("Hello chat - button send")
        send_btn = page.locator('#chat-send')
        await send_btn.click(timeout=5000)
        await page.wait_for_timeout(1000)
        await expect(chat_input).to_be_visible(timeout=3000)
        await expect(send_btn).to_be_visible(timeout=3000)
    finally:
        if context: await context.close()
        if browser: await browser.close()
        if pw: await pw.stop()
asyncio.run(run_test())
