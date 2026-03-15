
# TestSprite AI Testing Report(MCP)

---

## 1️⃣ Document Metadata
- **Project Name:** whitelinez-frontend
- **Date:** 2026-03-04
- **Prepared by:** TestSprite AI Team

---

## 2️⃣ Requirement Validation Summary

#### Test TC001 TC001-FPS badge overlay is visible on the stream
- **Test Code:** [TC001_FPS_badge_overlay_is_visible_on_the_stream.py](./TC001_FPS_badge_overlay_is_visible_on_the_stream.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/2b0a340b-7bf4-4d23-b998-12911f1a3b29
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC002 TC002-Detection zone overlay is drawn on the stream
- **Test Code:** [TC002_Detection_zone_overlay_is_drawn_on_the_stream.py](./TC002_Detection_zone_overlay_is_drawn_on_the_stream.py)
- **Test Error:** Verification complete: The live stream video is visible, the detection zone overlay is visible on the stream, and the FPS badge is visible. However, the text 'SIGNAL LOST' is visible on the dashboard, which is unexpected according to the test instructions.
Browser Console Logs:
[ERROR] Failed to load resource: the server responded with a status of 404 (Not Found) (at http://localhost:5173/_vercel/insights/script.js:0:0)
[WARNING] [Stream] init failed — page continues without stream: Unexpected token '<', "<!DOCTYPE "... is not valid JSON (at http://localhost:5173/src/main.js:448:12)
[WARNING] [DetectionOverlay] WebGL unsupported/blocked on this browser context (at http://localhost:5173/src/overlays/detection-overlay.js:397:14)
[WARNING] [GroupMarkerNotSet(crbug.com/242999)!:A0402602FC360000]Automatic fallback to software WebGL has been deprecated. Please use the --enable-unsafe-swiftshader (about:flags#enable-unsafe-swiftshader) flag to opt in to lower security guarantees for trusted content. (at http://localhost:5173/:0:0)
[WARNING] [GroupMarkerNotSet(crbug.com/242999)!:A06C2602FC360000]Automatic fallback to software WebGL has been deprecated. Please use the --enable-unsafe-swiftshader (about:flags#enable-unsafe-swiftshader) flag to opt in to lower security guarantees for trusted content. (at http://localhost:5173/:0:0)
[WARNING] [.WebGL-0x36fc046b8680]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels (at http://localhost:5173/:0:0)
[WARNING] [.WebGL-0x36fc046b8680]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels (at http://localhost:5173/:0:0)
[WARNING] [.WebGL-0x36fc046b8680]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels (at http://localhost:5173/:0:0)
[WARNING] [.WebGL-0x36fc046b8680]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels (this message will no longer repeat) (at http://localhost:5173/:0:0)
[ERROR] Failed to load resource: the server responded with a status of 404 (Not Found) (at http://localhost:5173/_vercel/insights/script.js:0:0)
[WARNING] [Stream] init failed — page continues without stream: Unexpected token '<', "<!DOCTYPE "... is not valid JSON (at http://localhost:5173/src/main.js:448:12)
[WARNING] [DetectionOverlay] WebGL unsupported/blocked on this browser context (at http://localhost:5173/src/overlays/detection-overlay.js:397:14)
[WARNING] [GroupMarkerNotSet(crbug.com/242999)!:A0007D05FC360000]Automatic fallback to software WebGL has been deprecated. Please use the --enable-unsafe-swiftshader (about:flags#enable-unsafe-swiftshader) flag to opt in to lower security guarantees for trusted content. (at http://localhost:5173/:0:0)
[WARNING] [GroupMarkerNotSet(crbug.com/242999)!:A0587D05FC360000]Automatic fallback to software WebGL has been deprecated. Please use the --enable-unsafe-swiftshader (about:flags#enable-unsafe-swiftshader) flag to opt in to lower security guarantees for trusted content. (at http://localhost:5173/:0:0)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/c154b8f6-b3c8-46e1-9b3f-2c3f400b3f99
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC004 TC004-Floating vehicle count widget is visible on the main dashboard
- **Test Code:** [TC004_Floating_vehicle_count_widget_is_visible_on_the_main_dashboard.py](./TC004_Floating_vehicle_count_widget_is_visible_on_the_main_dashboard.py)
- **Test Error:** Test execution timed out after 15 minutes
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/5a0aecc9-9232-4877-8a7d-0336ee32b594
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC005 TC005-Vehicle count value updates over time (realtime WebSocket feed)
- **Test Code:** [TC005_Vehicle_count_value_updates_over_time_realtime_WebSocket_feed.py](./TC005_Vehicle_count_value_updates_over_time_realtime_WebSocket_feed.py)
- **Test Error:** The task goal was to verify that the vehicle count changes over time, indicating that real-time updates are being received. However, the last action attempted to click on an element that was not interactable due to an overlay blocking it. The error message indicates that the click action timed out after 5000ms because the element was intercepted by a modal dialog (the onboarding overlay). This overlay prevented the click from being executed, even though the target element was visible and stable. To resolve this issue, you need to ensure that the overlay is closed or hidden before attempting to click on the vehicle count element.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/c0096905-aff6-4d18-8c35-97c7cd05c356
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC008 TC008-Guess mode progress display appears when entering guess mode
- **Test Code:** [TC008_Guess_mode_progress_display_appears_when_entering_guess_mode.py](./TC008_Guess_mode_progress_display_appears_when_entering_guess_mode.py)
- **Test Error:** The click action on the 'Guess' or 'Start Guess' control failed because the element was obstructed by an overlay dialog, specifically the 'Welcome' onboarding overlay. This overlay intercepts pointer events, preventing the click from being registered. The timeout of 5000ms was exceeded while waiting for the element to become clickable, as the script repeatedly attempted to click the button but was blocked by the overlay. To resolve this issue, the onboarding overlay should be closed or hidden before attempting to click the button again.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/6f5d1f4c-9ca2-4b84-8904-d612d29ec179
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC011 TC011-Place a valid guess during an active round and see an active receipt
- **Test Code:** [TC011_Place_a_valid_guess_during_an_active_round_and_see_an_active_receipt.py](./TC011_Place_a_valid_guess_during_an_active_round_and_see_an_active_receipt.py)
- **Test Error:** Test execution timed out after 15 minutes
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/a977becc-9aa5-42fe-ae2f-5887c3e89656
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC012 TC012-Scorecard appears after round resolves for a submitted guess
- **Test Code:** [TC012_Scorecard_appears_after_round_resolves_for_a_submitted_guess.py](./TC012_Scorecard_appears_after_round_resolves_for_a_submitted_guess.py)
- **Test Error:** The task goal was to verify that after placing a guess, the UI should display a scoring card (EXACT/CLOSE/MISS) once the round resolves. However, the last action attempted to click the 'Login' button, which failed due to a timeout error. The error message indicates that the click action could not be completed because a modal overlay (the onboarding overlay) was intercepting pointer events, preventing interaction with the button. This means that the UI was not in a state that allowed the click to be processed, which is why the expected scoring card was not displayed. To resolve this, ensure that any modal overlays are closed or hidden before attempting to interact with the UI elements.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/d70c3156-8b22-4370-bca1-50d9c27c3fd9
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC013 TC013-Non-numeric guess input shows validation error and blocks submission
- **Test Code:** [TC013_Non_numeric_guess_input_shows_validation_error_and_blocks_submission.py](./TC013_Non_numeric_guess_input_shows_validation_error_and_blocks_submission.py)
- **Test Error:** The task goal was to verify that entering a non-numeric value results in a visible validation error and does not create an active guess receipt. However, the last action attempted to click the 'Login' button, which failed due to a timeout error. The error message indicates that the click action could not be completed because a modal dialog (the onboarding overlay) was intercepting pointer events, preventing interaction with the button. This means that the expected validation error could not be triggered because the necessary UI element was not accessible for interaction. To resolve this, ensure that any overlays or modals are closed or hidden before attempting to click the button.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/99b4ac6e-7207-45bb-a2f4-783acb445a21
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC019 TC019-Open Leaderboard and view default ranked list
- **Test Code:** [TC019_Open_Leaderboard_and_view_default_ranked_list.py](./TC019_Open_Leaderboard_and_view_default_ranked_list.py)
- **Test Error:** Test execution timed out after 15 minutes
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/ad932acc-904a-4ceb-b83a-c1b36bfc5e0f
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC020 TC020-Switch to 3MIN leaderboard tab and see updated list
- **Test Code:** [TC020_Switch_to_3MIN_leaderboard_tab_and_see_updated_list.py](./TC020_Switch_to_3MIN_leaderboard_tab_and_see_updated_list.py)
- **Test Error:** The task goal was to verify that switching the time-window tab to 3MIN updates the visible leaderboard state. However, the last action attempted to click on the 'Leaderboard' tab but failed due to a timeout error. The error message indicates that the click action could not be completed because a modal dialog (the onboarding overlay) was intercepting pointer events, preventing interaction with the button. This means that the button was technically visible and enabled, but the overlay was blocking it, causing the click action to fail after exceeding the 5000ms timeout. To resolve this issue, the onboarding overlay needs to be closed or hidden before attempting to click the 'Leaderboard' tab.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/be5d8c71-0c0c-4d83-b851-fca6a7ef138f
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC022 TC022-Manual refresh reloads scores on 3MIN tab
- **Test Code:** [TC022_Manual_refresh_reloads_scores_on_3MIN_tab.py](./TC022_Manual_refresh_reloads_scores_on_3MIN_tab.py)
- **Test Error:** The task goal was to verify that the refresh button reloads leaderboard scores while remaining on the selected time-window tab. However, the last action attempted to click the 'Leaderboard' tab, which failed due to a timeout error. The error message indicates that the click action could not be completed because a modal dialog (the onboarding overlay) was intercepting pointer events, preventing interaction with the button. This means that the button was not clickable at the time of the action, likely because the onboarding overlay was still visible on the screen. To resolve this issue, ensure that the onboarding overlay is closed or hidden before attempting to click the 'Leaderboard' tab again.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/6bd581fe-0c20-4703-9d6c-258965d8eb75
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC025 TC025-Send a chat message with Enter and see it appear in chat panel
- **Test Code:** [TC025_Send_a_chat_message_with_Enter_and_see_it_appear_in_chat_panel.py](./TC025_Send_a_chat_message_with_Enter_and_see_it_appear_in_chat_panel.py)
- **Test Error:** The task goal was to verify that a user can post a message via the Enter key and that it appears in the chat list in real time. However, the last action attempted was to click the 'Chat' tab to open the chat panel, which is necessary for the chat input to become available. The click action failed due to a timeout error, indicating that the click could not be completed within the specified time limit of 5000ms.

The error log reveals that the click action was intercepted by an onboarding overlay (a dialog with the ID 'onboarding-overlay'). This overlay was blocking the interaction with the 'Chat' tab button, preventing the click from being registered. The element was visible and enabled, but the overlay was intercepting pointer events, which caused the click action to fail repeatedly.

To resolve this issue, you may need to dismiss or close the onboarding overlay before attempting to click the 'Chat' tab again. Once the overlay is removed, the click action should succeed, allowing the chat input to become available for posting messages.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/78c52617-dd9f-4d84-8575-31cfeda959e8
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC026 TC026-Send a chat message with the Send button and see it appear
- **Test Code:** [TC026_Send_a_chat_message_with_the_Send_button_and_see_it_appear.py](./TC026_Send_a_chat_message_with_the_Send_button_and_see_it_appear.py)
- **Test Error:** The task goal was to verify that a user can post a message via the Send button, which should appear in the chat list. However, the last action attempted to click the 'Chat' tab button, but it failed due to a timeout error. The error message indicates that the click action could not be completed because a modal overlay (the onboarding overlay) was intercepting pointer events, preventing interaction with the button. This means that the button was not clickable at the time of the action, likely because the onboarding overlay was still displayed on the screen. To resolve this issue, ensure that the onboarding overlay is closed or hidden before attempting to click the 'Chat' tab.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/73a49f5a-c036-4853-a35a-81bb05a92ca6
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC027 TC027-Posting a message creates an activity feed overlay entry
- **Test Code:** [TC027_Posting_a_message_creates_an_activity_feed_overlay_entry.py](./TC027_Posting_a_message_creates_an_activity_feed_overlay_entry.py)
- **Test Error:** The task goal was to verify that after sending a message, an activity feed item appears over the stream area. However, the last action attempted to click the 'Chat' tab to open the chat/live panel, but it failed due to a timeout error. The error message indicates that the click action could not be completed because a modal dialog (the onboarding overlay) was intercepting pointer events, preventing interaction with the 'Chat' tab button. This means that the button was not clickable at the time of the action, which is why the expected outcome (the appearance of the activity feed item) could not be achieved. To resolve this, ensure that the onboarding overlay is closed or hidden before attempting to click the 'Chat' tab.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/7e050ea0-560b-436d-9a9b-e237f4fef453
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC031 TC031-Register a new account from the auth modal and see avatar + balance in the nav
- **Test Code:** [TC031_Register_a_new_account_from_the_auth_modal_and_see_avatar__balance_in_the_nav.py](./TC031_Register_a_new_account_from_the_auth_modal_and_see_avatar__balance_in_the_nav.py)
- **Test Error:** The task goal was to verify that a user can register successfully and that the UI updates to show the logged-in state, including the avatar and balance. However, the last action, which involved clicking the 'Login' button in the navigation bar, failed due to a timeout error. 

### Analysis:
1. **Task Goal**: The goal was to ensure that after clicking the 'Login' button, the user would be able to log in and see the updated UI.
2. **Last Action**: The action attempted was to click the 'Login' button, but it encountered an issue where a modal overlay (identified as `onboarding-overlay`) was intercepting pointer events, preventing the click from being registered.
3. **Error**: The error message indicates that the click action timed out after 5000ms because the button was not clickable due to the overlay.

### Explanation of the Error:
The error occurred because the 'Login' button was covered by a modal dialog (the onboarding overlay), which prevented the click action from being executed. Even though the button was visible and enabled, the overlay intercepts pointer events, making it impossible to interact with the button. To resolve this issue, the overlay needs to be closed or hidden before attempting to click the 'Login' button again.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/b44a350c-9eae-4a7e-be46-0fa706b27bcc/b2c6ac07-6780-4b7d-859d-6ba7f768ac83
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---


## 3️⃣ Coverage & Matching Metrics

- **6.67** of tests passed

| Requirement        | Total Tests | ✅ Passed | ❌ Failed  |
|--------------------|-------------|-----------|------------|
| ...                | ...         | ...       | ...        |
---


## 4️⃣ Key Gaps / Risks
{AI_GNERATED_KET_GAPS_AND_RISKS}
---