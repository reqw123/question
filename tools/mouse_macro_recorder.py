# -*- coding: utf-8 -*-
"""
==================================================================
滑鼠座標控制實驗 (Mouse Coordinate Control Lab)
------------------------------------------------------------------
用途：
    這是一個學習用的 Windows 桌面自動化實驗程式。
    透過 pyautogui 控制滑鼠，並用 Tkinter 建立操作介面。

功能：
    1. 即時顯示滑鼠座標 (X, Y)
    2. 記錄目前滑鼠位置成一個座標點（支援按鈕點擊 或 全域快捷鍵 F8 觸發）
    3. 可累積多個座標點，形成一條「移動路徑」
    4. 播放時依序移動到每個座標、停留、左鍵點擊（支援按鈕 或 快捷鍵 F9 觸發）
    5. 提供速度控制（移動快慢）
    6. 提供停止按鈕（支援按鈕 或 快捷鍵 F10 觸發，可隨時中斷播放）
    7. 啟用 PyAutoGUI 的 FAILSAFE 機制
       （滑鼠快速移到螢幕左上角 (0,0) 會立即拋出例外、中止程式操作）
    8. 全域快捷鍵：即使目前焦點不在本程式視窗上（例如滑鼠正停在瀏覽器/
       遊戲畫面上），也能透過鍵盤觸發記錄/播放/停止，
       原理是透過 pynput 在系統層級安裝「低階鍵盤鉤子」(Low-Level Keyboard Hook)。
    9. 每個座標點可額外附加「按鍵/組合鍵」設定，例如 enter、ctrl+c、alt+tab，
       播放時會在該座標「點擊」之後，額外模擬這個按鍵動作。
    10. 排程模式：可設定「特定時間」自動開始播放，並指定「重複執行次數」，
        程式會在背景倒數，時間一到就依序執行完整軌跡，可重複多次。
    11. 每個座標點可獨立選擇「滑鼠動作」：左鍵點擊、右鍵點擊、或不點擊，
        搭配「按鍵/組合鍵」欄位，可以組合出只點擊、只按鍵、兩者都要、
        或兩者都不觸發（純粹移動滑鼠）等各種情境。
    12. 快速連按：可獨立觸發（不需記錄座標，直接在「目前滑鼠位置」以指定
        每秒點擊次數連續點擊指定次數），也可以「插入」成事件清單裡的一步，
        安插在任兩個座標點中間，播放到該步時就在當下位置原地連續點擊。

快捷鍵一覽：
    F8  = 記錄目前滑鼠座標
    F9  = 開始播放
    F10 = 停止播放（同時也能取消排程中的倒數或重複執行、快速連按）
    F11 = 在目前滑鼠位置開始快速連按

注意事項：
    - 本程式僅供學習 Windows 自動化原理使用。
    - 請勿用於未經授權的帳號操作、遊戲外掛、繞過驗證機制等用途。
    - 執行前建議先在不重要的視窗/畫面上測試，避免誤觸重要按鈕。
    - 需要額外安裝 pynput：pip install pynput
==================================================================
"""

import tkinter as tk                # Tkinter：Python 內建的 GUI 函式庫，用來畫視窗、按鈕、標籤
from tkinter import messagebox      # messagebox 用來跳出提示視窗
import pyautogui                    # pyautogui：跨平台的滑鼠/鍵盤自動化函式庫
import threading                    # threading：用來讓「播放座標」在背景執行緒執行，避免卡住 GUI
import time                         # time：用來做「停留幾秒」的延遲
from datetime import datetime, timedelta  # 用來計算「排程目標時間」與倒數剩餘時間

# pynput：用來監聽「全域鍵盤事件」的函式庫。
# 與 Tkinter 內建的 bind() 不同，pynput 在 Windows 上是透過 ctypes
# 呼叫 SetWindowsHookEx(WH_KEYBOARD_LL, ...) 安裝「系統層級」的鍵盤鉤子，
# 所以即使焦點不在本程式視窗上，也能攔截到按鍵事件。
from pynput import keyboard as pynput_keyboard


# ------------------------------------------------------------------
# 【安全機制設定】PyAutoGUI 的 FAILSAFE
# ------------------------------------------------------------------
# FAILSAFE = True 是 pyautogui 內建的緊急停止機制。
# 只要偵測到滑鼠目前座標在螢幕「左上角 (0,0)」，
# pyautogui 下一次呼叫移動/點擊函式時就會拋出 pyautogui.FailSafeException，
# 讓程式立刻中止動作，避免自動化程式失控。
#
# 使用方式：操作過程中若想緊急停止，只要把滑鼠用力甩到螢幕左上角即可。
pyautogui.FAILSAFE = True

# PAUSE 是「每一次 pyautogui 動作之間」自動插入的延遲秒數（秒）。
# 設定一個小延遲可以讓系統有時間處理每個輸入事件，避免動作太快系統來不及反應。
pyautogui.PAUSE = 0.1


class MouseCoordinateLab:
    """
    整個實驗程式的主要類別。
    把「介面」與「邏輯」都包在這個類別裡，方便管理狀態（座標清單、是否正在播放等）。
    """

    def __init__(self, root):
        # root 是 Tkinter 的主視窗物件 (tk.Tk())
        self.root = root
        self.root.title("滑鼠座標控制實驗 - Windows 自動化原理教學")
        self.root.geometry("500x700")   # 設定視窗初始大小：寬500 高700 (像素)
        self.root.resizable(True, True)  # 內容變多了，改為允許使用者自行調整視窗大小

        # ------------------------------------------------------------
        # 【狀態變數】用來記錄程式目前的運作狀態
        # ------------------------------------------------------------
        self.recorded_points = []   # 儲存所有已記錄的座標點，格式：[{"x":x,"y":y,"key":key_or_None}, ...]
        self.is_playing = False     # 是否正在播放中（True 表示正在自動移動滑鼠，涵蓋一般播放與排程執行）
        self.stop_requested = False # 使用者是否按下了「停止」按鈕（用來通知背景執行緒中斷，也用來取消排程）
        self.is_scheduling = False  # 是否有排程正在等待/執行中（用來避免重複設定排程）
        self.scheduled_tasks = []   # 排程任務佇列，格式：[{"target_dt":..., "repeat_count":..., "interval":...}, ...]

        # 建立所有畫面元件（按鈕、標籤等）
        self._build_ui()

        # 啟動「即時座標更新」的迴圈，每隔一段時間更新一次畫面上的座標顯示
        self._update_current_position()

        # 啟動「排程倒數」的即時更新迴圈——不管排程佇列有沒有按下啟動，
        # 只要佇列裡有任務，就持續顯示「距離最近一筆排程還剩多少時間」。
        self._update_schedule_countdown()

        # 啟動全域快捷鍵監聽（F8 記錄 / F9 播放 / F10 停止 / F11 快速連按）
        self._start_hotkey_listener()

        # 當使用者按下視窗右上角「X」關閉視窗時，先呼叫 self._on_close
        # 確保背景的鍵盤監聽執行緒也會被正確關閉，不留下殘留的系統鉤子。
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ==================================================================
    # 介面建立區
    # ==================================================================
    def _build_ui(self):
        """
        建立所有畫面元件：標籤、按鈕、清單框、滑桿等。

        整體版面用「Canvas + Scrollbar」包起來，而不是直接把元件塞進 self.root。
        原因：功能一直增加（記錄、播放、排程...），總高度已經超過螢幕能顯示的範圍，
             如果元件直接塞進固定大小的視窗，超出視窗高度的部分會被裁切、
             完全看不到也點不到（這正是排程模式按鈕消失不見的原因）。
             改用可捲動的畫布後，不管視窗多小、之後又加了多少新功能，
             使用者都能透過滾動捲軸看到並操作到最下面的元件。
        """
        # Canvas：一塊可以「局部繪製、局部捲動」的畫布區域
        canvas = tk.Canvas(self.root, highlightthickness=0)
        canvas.pack(side="left", fill="both", expand=True)

        # 垂直捲軸，綁定到 canvas 的上下捲動
        outer_scrollbar = tk.Scrollbar(self.root, orient="vertical", command=canvas.yview)
        outer_scrollbar.pack(side="right", fill="y")
        canvas.configure(yscrollcommand=outer_scrollbar.set)

        # self.main_frame 是實際承載所有 LabelFrame/元件的容器，
        # 它被放進 canvas 裡面，而不是直接放進 root。
        self.main_frame = tk.Frame(canvas)
        canvas_window = canvas.create_window((0, 0), window=self.main_frame, anchor="nw")

        def _on_frame_configure(event):
            # 每當 main_frame 內容改變大小（例如新增座標點），
            # 就重新計算 canvas 的「可捲動範圍」，確保捲軸長度正確。
            canvas.configure(scrollregion=canvas.bbox("all"))

        def _on_canvas_resize(event):
            # 當視窗寬度改變時，讓 main_frame 的寬度跟著 canvas 一樣寬，
            # 避免內部元件的 fill="x" 失去效果（維持版面隨視窗縮放）。
            canvas.itemconfig(canvas_window, width=event.width)

        self.main_frame.bind("<Configure>", _on_frame_configure)
        canvas.bind("<Configure>", _on_canvas_resize)

        def _on_mousewheel(event):
            # Windows 滑鼠滾輪的 event.delta 是 120 的倍數，
            # 除以 120 再乘上負號，讓「往上滾」對應「往上捲動」。
            canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

        # 只在滑鼠停留在這個視窗範圍內時才綁定滾輪事件，
        # 避免影響到其他同時開啟的視窗（例如按鍵對照表）。
        canvas.bind("<Enter>", lambda e: canvas.bind_all("<MouseWheel>", _on_mousewheel))
        canvas.bind("<Leave>", lambda e: canvas.unbind_all("<MouseWheel>"))

        # -------------------- 區塊一：即時滑鼠座標 --------------------
        frame_pos = tk.LabelFrame(self.main_frame, text="即時滑鼠座標", padx=10, pady=10)
        frame_pos.pack(fill="x", padx=10, pady=5)  # fill="x" 讓區塊寬度隨視窗延展

        # 這個 Label 會被 _update_current_position() 持續更新內容
        self.label_current_pos = tk.Label(
            frame_pos, text="X: ---, Y: ---", font=("Consolas", 16, "bold")
        )
        self.label_current_pos.pack()

        # -------------------- 區塊二：記錄座標 --------------------
        frame_record = tk.LabelFrame(self.main_frame, text="記錄座標", padx=10, pady=10)
        frame_record.pack(fill="x", padx=10, pady=5)

        # 按下此按鈕時，會呼叫 self.record_point 把「目前滑鼠位置」加入清單
        # 註：此按鈕與「F8 快捷鍵」呼叫的是同一個函式 self.record_point，
        #     兩種觸發方式效果完全相同，快捷鍵只是多一種觸發途徑。
        btn_record = tk.Button(
            frame_record, text="📍 記錄座標 (F8)", command=self.record_point,
            bg="#4CAF50", fg="white", font=("Microsoft JhengHei", 11, "bold")
        )
        btn_record.pack(fill="x")

        # 提示文字：說明可用全域快捷鍵操作，不需要滑鼠點擊本視窗
        tk.Label(
            frame_record,
            text="提示：滑鼠移到目標位置後，直接按鍵盤 F8 即可記錄，\n"
                 "不需要把滑鼠移回來點按鈕（全域快捷鍵，任何視窗焦點下皆可用）。",
            fg="#555555", justify="left", font=("Microsoft JhengHei", 9)
        ).pack(anchor="w", pady=(5, 0))

        # ---- 滑鼠動作設定 ----
        # 讓使用者為「下一個要記錄的座標點」選擇滑鼠要做什麼：左鍵點擊、右鍵點擊、
        # 或完全不點擊。設計成跟下面的「按鍵/組合鍵」互相獨立，
        # 這樣就能組合出各種情境：只點擊、只按鍵、點擊+按鍵、甚至兩者都不觸發
        # （例如只是想單純移動滑鼠到某處，不做任何動作）。
        #
        # 用 tk.StringVar 搭配三個 Radiobutton 是 Tkinter 裡「單選」的標準做法——
        # 三個 Radiobutton 共用同一個 StringVar，選中誰，變數的值就變成誰的 value，
        # 跟網頁表單的 <input type="radio" name="..."> 是一樣的概念。
        frame_click_type = tk.Frame(frame_record)
        frame_click_type.pack(fill="x", pady=(8, 0))

        tk.Label(frame_click_type, text="滑鼠動作：").pack(side="left")

        self.click_type_var = tk.StringVar(value="left")  # 預設為左鍵點擊，維持原本的行為

        tk.Radiobutton(
            frame_click_type, text="左鍵點擊", variable=self.click_type_var, value="left"
        ).pack(side="left")
        tk.Radiobutton(
            frame_click_type, text="右鍵點擊", variable=self.click_type_var, value="right"
        ).pack(side="left")
        tk.Radiobutton(
            frame_click_type, text="不點擊", variable=self.click_type_var, value="none"
        ).pack(side="left")

        tk.Label(
            frame_record,
            text="說明：選「不點擊」時，這個座標點只會移動滑鼠過去，不會觸發任何點擊，\n"
                 "適合搭配下面的按鍵欄位，做出「只按鍵、不點滑鼠」的動作。",
            fg="#555555", justify="left", font=("Microsoft JhengHei", 9)
        ).pack(anchor="w", pady=(3, 0))

        # ---- 按鍵/組合鍵設定（選填） ----
        # 這個輸入框讓使用者可以為「下一個要記錄的座標點」
        # 附加一個按鍵動作，例如：enter、tab、esc、ctrl+c、alt+tab。
        # 記錄時（按 F8 或按鈕）會一併讀取這裡目前的內容，跟座標存在一起。
        frame_key = tk.Frame(frame_record)
        frame_key.pack(fill="x", pady=(8, 0))

        tk.Label(frame_key, text="按鍵/組合鍵（選填，例：enter、ctrl+c、alt+tab）：").pack(anchor="w")

        # 輸入框 + 對照表按鈕 放在同一列
        frame_key_input_row = tk.Frame(frame_key)
        frame_key_input_row.pack(fill="x")

        self.entry_key = tk.Entry(frame_key_input_row, font=("Consolas", 11))
        self.entry_key.pack(side="left", fill="x", expand=True)

        btn_key_reference = tk.Button(
            frame_key_input_row, text="📖 按鍵對照表", command=self.show_key_reference
        )
        btn_key_reference.pack(side="left", padx=(5, 0))

        tk.Label(
            frame_record,
            text="說明：多個鍵用「+」分隔即為組合鍵；只填一個字則是單鍵。\n"
                 "播放時會在該座標「點擊」完成後，接著模擬這個按鍵。\n"
                 "留空表示這個座標點只有滑鼠點擊，不觸發任何按鍵。",
            fg="#555555", justify="left", font=("Microsoft JhengHei", 9)
        ).pack(anchor="w", pady=(3, 0))

        # -------------------- 區塊三：事件清單（座標點 + 快速連按事件） --------------------
        # 這個清單現在裝的不只是座標點，還可以插入「快速連按事件」，
        # 兩種項目依清單順序依序執行——這樣就能做出
        # 「移動到A點點擊 -> 原地快速連按5次 -> 移動到B點點擊」這種混合流程。
        frame_list = tk.LabelFrame(self.main_frame, text="事件清單（座標點 + 快速連按，依序執行）", padx=10, pady=10)
        frame_list.pack(fill="both", expand=True, padx=10, pady=5)

        # Listbox：用來顯示所有已記錄的事件（座標點或快速連按），一行一個
        self.listbox_points = tk.Listbox(frame_list, font=("Consolas", 11), height=8)
        self.listbox_points.pack(side="left", fill="both", expand=True)

        # 幫 Listbox 加上垂直捲軸，避免項目太多時看不到
        scrollbar = tk.Scrollbar(frame_list, orient="vertical")
        scrollbar.pack(side="right", fill="y")
        self.listbox_points.config(yscrollcommand=scrollbar.set)
        scrollbar.config(command=self.listbox_points.yview)

        tk.Label(
            self.main_frame,
            text="提示：新增座標點或插入快速連按事件時，若清單裡有選取項目，\n"
                 "會插入到「選取項目的下一個位置」；沒有選取則加到清單最後面。",
            fg="#555555", justify="left", font=("Microsoft JhengHei", 9)
        ).pack(anchor="w", padx=10, pady=(2, 0))

        # 刪除選取項目 / 清空全部項目 的按鈕列
        frame_list_btns = tk.Frame(self.main_frame)
        frame_list_btns.pack(fill="x", padx=10, pady=(5, 0))

        btn_delete = tk.Button(
            frame_list_btns, text="🗑 刪除選取項目", command=self.delete_selected_point
        )
        btn_delete.pack(side="left", expand=True, fill="x", padx=(0, 5))

        btn_clear = tk.Button(
            frame_list_btns, text="🧹 清空全部項目", command=self.clear_all_points
        )
        btn_clear.pack(side="left", expand=True, fill="x")

        # -------------------- 區塊四：播放設定（速度、停留秒數） --------------------
        frame_settings = tk.LabelFrame(self.main_frame, text="播放設定", padx=10, pady=10)
        frame_settings.pack(fill="x", padx=10, pady=5)

        # ---- 點擊觸發間隔滑桿 ----
        # 定義：滑鼠「移動到定位」之後，要再等多久才觸發左鍵點擊。
        # 這是刻意跟下面的「點擊後停留秒數」分開的獨立設定——
        # 定位到點擊通常只需要短暫的反應時間（預設 0.5 秒），
        # 但點擊完之後可能需要等頁面載入、等程式回應，這種等待常常要拉到幾十秒，
        # 兩者的用途不同，混在同一個數值裡沒辦法同時滿足「快速點擊」跟「長時間等待」。
        tk.Label(frame_settings, text="點擊觸發間隔（定位後多久觸發點擊，秒）：").pack(anchor="w")
        self.scale_click_delay = tk.Scale(
            frame_settings, from_=0.0, to=10.0, resolution=0.1,
            orient="horizontal"
        )
        self.scale_click_delay.set(0.5)  # 預設定位後 0.5 秒觸發點擊
        self.scale_click_delay.pack(fill="x")

        # ---- 移動速度滑桿 ----
        # 這裡的「速度」定義為：滑鼠從目前位置移動到目標座標所花的秒數。
        # 數值越小 = 移動越快；數值越大 = 移動越慢（越像人手動拖曳，甚至可以拉到幾十秒）。
        # 範圍拉大到 0.1~60 秒後，把解析度從 0.1 調整為 0.5，
        # 避免滑桿總長度對應的「格數」太多（600格）導致拖曳時很難精準對到想要的數值；
        # 0.5 秒的精細度對於「移動快慢」這種需求已經足夠。
        tk.Label(frame_settings, text="移動速度（秒，數值越小越快，最長可設 60 秒）：").pack(anchor="w")
        self.scale_speed = tk.Scale(
            frame_settings, from_=0.1, to=60.0, resolution=0.5,
            orient="horizontal"
        )
        self.scale_speed.set(0.5)  # 預設移動耗時 0.5 秒
        self.scale_speed.pack(fill="x")

        # ---- 點擊後停留秒數 ----
        # 點擊完成（以及按鍵動作，如果有設定的話）之後，
        # 停留這麼久才前往下一個座標點——用來等待畫面反應、頁面載入等情境，
        # 上限拉大到 60 秒，方便需要長時間等待的情境。
        tk.Label(frame_settings, text="點擊後停留秒數（等待畫面反應，最長可設 60 秒）：").pack(anchor="w")
        self.scale_wait = tk.Scale(
            frame_settings, from_=0.0, to=60.0, resolution=0.5,
            orient="horizontal"
        )
        self.scale_wait.set(0.5)  # 預設停留 0.5 秒
        self.scale_wait.pack(fill="x")

        # -------------------- 區塊五：播放 / 停止控制 --------------------
        frame_control = tk.Frame(self.main_frame)
        frame_control.pack(fill="x", padx=10, pady=10)

        self.btn_play = tk.Button(
            frame_control, text="▶ 開始播放 (F9)", command=self.start_playback,
            bg="#2196F3", fg="white", font=("Microsoft JhengHei", 12, "bold")
        )
        self.btn_play.pack(side="left", expand=True, fill="x", padx=(0, 5))

        self.btn_stop = tk.Button(
            frame_control, text="⏹ 停止 (F10)", command=self.stop_playback,
            bg="#F44336", fg="white", font=("Microsoft JhengHei", 12, "bold")
        )
        self.btn_stop.pack(side="left", expand=True, fill="x")

        # -------------------- 區塊五之一：快速連按 --------------------
        # 這裡的設定同時支援兩種用法：
        #   1. 「⚡ 開始快速連按」：立刻在目前滑鼠位置執行一次（跟事件清單無關）
        #   2. 「➕ 插入快速連按事件」：把這裡的設定包成一筆「事件」，
        #      插進上面的事件清單裡，播放時會在清單跑到這一筆時，
        #      在「當下滑鼠所在位置」（也就是清單中前一步移動到的位置）執行，
        #      執行完才會繼續往清單下一筆走——這樣就能做出
        #      「移動到A點點擊 -> 原地快速連按5次 -> 移動到B點點擊」這種混合流程。
        frame_rapid = tk.LabelFrame(self.main_frame, text="快速連按", padx=10, pady=10)
        frame_rapid.pack(fill="x", padx=10, pady=5)

        tk.Label(
            frame_rapid,
            text="用法一：先把滑鼠移到目標位置，按下方「開始快速連按」或 F11，\n"
                 "立刻在目前滑鼠位置連續點擊（跟下面的事件清單無關）。\n"
                 "用法二：按「插入快速連按事件」，把這裡的設定變成清單中的一步，\n"
                 "播放時執行到這一步才會觸發，可以插在任兩個座標點中間。",
            fg="#555555", justify="left", font=("Microsoft JhengHei", 9)
        ).pack(anchor="w", pady=(0, 8))

        # ---- 連按按鍵：左鍵 / 右鍵 ----
        frame_rapid_button_type = tk.Frame(frame_rapid)
        frame_rapid_button_type.pack(fill="x")
        tk.Label(frame_rapid_button_type, text="連按按鍵：").pack(side="left")
        self.rapid_click_button_var = tk.StringVar(value="left")
        tk.Radiobutton(
            frame_rapid_button_type, text="左鍵", variable=self.rapid_click_button_var, value="left"
        ).pack(side="left")
        tk.Radiobutton(
            frame_rapid_button_type, text="右鍵", variable=self.rapid_click_button_var, value="right"
        ).pack(side="left")

        # ---- 每秒點擊次數 ----
        # 這裡的「速率」定義為：一秒鐘要點擊幾次。數值越大點越快，
        # 但實際能達到的速率仍受限於系統處理輸入事件的速度，
        # 太高的數值（例如 50 次/秒）在某些應用程式上不一定能完整反應每一次點擊。
        tk.Label(frame_rapid, text="每秒點擊次數（次/秒，數值越大越快）：").pack(anchor="w", pady=(8, 0))
        self.scale_rapid_rate = tk.Scale(
            frame_rapid, from_=1, to=50, resolution=1, orient="horizontal"
        )
        self.scale_rapid_rate.set(10)  # 預設每秒點擊 10 次
        self.scale_rapid_rate.pack(fill="x")

        # ---- 點擊次數 ----
        frame_rapid_count = tk.Frame(frame_rapid)
        frame_rapid_count.pack(fill="x", pady=(8, 0))
        tk.Label(frame_rapid_count, text="總點擊次數：").pack(side="left")
        self.spin_rapid_count = tk.Spinbox(
            frame_rapid_count, from_=1, to=9999, width=6, font=("Consolas", 11)
        )
        self.spin_rapid_count.delete(0, "end")
        self.spin_rapid_count.insert(0, "20")  # 預設連按 20 次
        self.spin_rapid_count.pack(side="left", padx=(5, 0))

        self.btn_rapid_click = tk.Button(
            frame_rapid, text="⚡ 開始快速連按 (F11，立即執行)", command=self.start_rapid_click,
            bg="#9C27B0", fg="white", font=("Microsoft JhengHei", 11, "bold")
        )
        self.btn_rapid_click.pack(fill="x", pady=(8, 0))

        self.btn_insert_rapid_click = tk.Button(
            frame_rapid, text="➕ 插入快速連按事件到清單", command=self.insert_rapid_click_event,
            bg="#7B1FA2", fg="white", font=("Microsoft JhengHei", 11, "bold")
        )
        self.btn_insert_rapid_click.pack(fill="x", pady=(5, 0))

        tk.Label(
            frame_rapid,
            text="提示：快速連按進行中，一樣可以按「⏹ 停止 (F10)」按鈕或快捷鍵中止。",
            fg="#555555", justify="left", font=("Microsoft JhengHei", 9)
        ).pack(anchor="w", pady=(3, 0))

        # -------------------- 區塊五之二：排程模式（多任務佇列） --------------------
        # 讓使用者設定「特定時間」+「重複執行次數」+「重複間隔」組成一筆排程任務，
        # 可以一次新增多筆，全部排進佇列，啟動後會依時間先後自動依序執行。
        # 例如：任務一 14:30 執行 3 次、任務二 16:00 執行 5 次——
        # 佇列會先等到 14:30 執行完任務一，接著繼續等到 16:00 執行任務二。
        frame_schedule = tk.LabelFrame(self.main_frame, text="排程模式", padx=10, pady=10)
        frame_schedule.pack(fill="x", padx=10, pady=5)

        # ---- 距離最近一筆排程的即時倒數 ----
        # 這個標籤由 _update_schedule_countdown() 持續更新，
        # 不管佇列有沒有按下「啟動排程佇列」，只要清單裡有任務就會顯示倒數，
        # 方便使用者隨時瞄一眼還剩多久，不用等到真正啟動才看得到。
        self.label_schedule_countdown = tk.Label(
            frame_schedule, text="距離最近排程：尚無排程任務",
            font=("Consolas", 12, "bold"), fg="#E65100"
        )
        self.label_schedule_countdown.pack(anchor="w", pady=(0, 8))

        # ---- 目標執行時間 ----
        tk.Label(frame_schedule, text="執行時間（24小時制，格式 HH:MM 或 HH:MM:SS）：").pack(anchor="w")
        self.entry_schedule_time = tk.Entry(frame_schedule, font=("Consolas", 11))
        self.entry_schedule_time.pack(fill="x")

        tk.Label(
            frame_schedule,
            text="若填寫的時間已經過了（例如現在是 15:00，卻填 14:30），\n"
                 "會視為「明天的這個時間」自動執行，不會立刻觸發。",
            fg="#555555", justify="left", font=("Microsoft JhengHei", 9)
        ).pack(anchor="w", pady=(2, 8))

        # ---- 重複執行次數 ----
        frame_repeat = tk.Frame(frame_schedule)
        frame_repeat.pack(fill="x")
        tk.Label(frame_repeat, text="重複執行次數：").pack(side="left")
        # Spinbox：專門用來輸入「整數次數」的元件，有上下箭頭可以調整數值，
        # 也能直接打字輸入，比 Scale 滑桿更適合「次數」這種離散整數的情境。
        self.spin_repeat = tk.Spinbox(frame_repeat, from_=1, to=999, width=6, font=("Consolas", 11))
        self.spin_repeat.delete(0, "end")
        self.spin_repeat.insert(0, "1")  # 預設執行 1 次
        self.spin_repeat.pack(side="left", padx=(5, 0))

        # ---- 每次重複之間的間隔秒數 ----
        # 解析度改成 0.1 秒（原本是 1 秒），可以設定更精細的重複間隔，例如 0.3 秒。
        tk.Label(frame_schedule, text="每次重複之間的間隔秒數（可精細到 0.1 秒）：").pack(anchor="w", pady=(8, 0))
        self.scale_interval = tk.Scale(
            frame_schedule, from_=0, to=60, resolution=0.1, orient="horizontal"
        )
        self.scale_interval.set(2)  # 預設每次重複之間間隔 2 秒
        self.scale_interval.pack(fill="x")

        # ---- 新增到排程佇列按鈕 ----
        # 按下這顆按鈕只是把「目前設定的時間/次數/間隔」包成一筆任務，加進佇列清單，
        # 並不會立刻開始倒數——真正開始執行要按下面的「▶ 啟動排程佇列」。
        self.btn_add_task = tk.Button(
            frame_schedule, text="➕ 新增排程任務", command=self.add_schedule_task,
            bg="#FF9800", fg="white", font=("Microsoft JhengHei", 11, "bold")
        )
        self.btn_add_task.pack(fill="x", pady=(8, 0))

        # ---- 排程任務佇列清單 ----
        tk.Label(frame_schedule, text="排程任務佇列（依執行時間排序）：").pack(anchor="w", pady=(10, 0))

        frame_schedule_list = tk.Frame(frame_schedule)
        frame_schedule_list.pack(fill="both", expand=True)

        self.listbox_schedule = tk.Listbox(frame_schedule_list, font=("Consolas", 10), height=5)
        self.listbox_schedule.pack(side="left", fill="both", expand=True)

        schedule_scrollbar = tk.Scrollbar(frame_schedule_list, orient="vertical")
        schedule_scrollbar.pack(side="right", fill="y")
        self.listbox_schedule.config(yscrollcommand=schedule_scrollbar.set)
        schedule_scrollbar.config(command=self.listbox_schedule.yview)

        # 刪除選取任務 / 清空全部任務 的按鈕列
        frame_schedule_btns = tk.Frame(frame_schedule)
        frame_schedule_btns.pack(fill="x", pady=(5, 0))

        self.btn_delete_task = tk.Button(
            frame_schedule_btns, text="🗑 刪除選取任務", command=self.delete_selected_task
        )
        self.btn_delete_task.pack(side="left", expand=True, fill="x", padx=(0, 5))

        self.btn_clear_tasks = tk.Button(
            frame_schedule_btns, text="🧹 清空全部任務", command=self.clear_all_tasks
        )
        self.btn_clear_tasks.pack(side="left", expand=True, fill="x")

        # ---- 啟動排程佇列按鈕 ----
        # 注意：這裡沒有另外做「取消排程」按鈕 —— 因為佇列執行期間
        # self.is_playing 會被設成 True，此時既有的「⏹ 停止 (F10)」
        # 按鈕與快捷鍵就能直接取消倒數中或執行中的整個佇列，邏輯是共用的。
        self.btn_schedule = tk.Button(
            frame_schedule, text="▶ 啟動排程佇列", command=self.start_schedule_queue,
            bg="#4CAF50", fg="white", font=("Microsoft JhengHei", 12, "bold")
        )
        self.btn_schedule.pack(fill="x", pady=(10, 0))

        tk.Label(
            frame_schedule,
            text="提示：佇列等待或執行中，都可以按「⏹ 停止 (F10)」按鈕或快捷鍵整個中止；\n"
                 "執行中無法新增/刪除任務，需先停止。",
            fg="#555555", justify="left", font=("Microsoft JhengHei", 9)
        ).pack(anchor="w", pady=(3, 0))

        # -------------------- 區塊六：狀態列 --------------------
        self.label_status = tk.Label(
            self.main_frame,
            text="狀態：待命中 | 快捷鍵 F8=記錄 F9=播放 F10=停止 F11=快速連按 | "
                 "緊急時可將滑鼠甩到螢幕左上角立即中止",
            fg="gray", anchor="w", wraplength=460, justify="left"
        )
        self.label_status.pack(fill="x", padx=10, pady=(0, 5))

    # ==================================================================
    # 座標即時更新
    # ==================================================================
    def _update_current_position(self):
        """
        使用 pyautogui.position() 取得目前滑鼠座標，
        並更新到畫面上的標籤。
        使用 self.root.after() 讓這個函式每 50 毫秒自動呼叫自己一次，
        形成一個「非阻塞式」的更新迴圈（不會卡住 Tkinter 的主事件迴圈）。
        """
        x, y = pyautogui.position()  # 取得目前滑鼠在螢幕上的絕對座標 (x, y)
        self.label_current_pos.config(text=f"X: {x}, Y: {y}")

        # 50 毫秒後再次呼叫自己，達成「即時更新」的效果
        self.root.after(50, self._update_current_position)

    def _update_schedule_countdown(self):
        """
        持續更新「距離最近排程還剩多少時間」的顯示。

        跟 _update_current_position() 是同樣的設計模式：用 self.root.after()
        讓函式每隔一段時間自動呼叫自己一次，形成非阻塞式的即時更新迴圈。

        佇列裡只要有任務，不管排程有沒有按下「啟動」都會持續顯示倒數，
        讓使用者能先確認時間設定得對不對；但「時間已到之後」要顯示成
        「執行中」還是「尚未啟動，時間已過」，就必須靠 self.is_playing
        來分辨——否則會誤導使用者以為背景真的在跑，但其實根本沒有執行緒在動作。
        """
        if not self.scheduled_tasks:
            self.label_schedule_countdown.config(text="距離最近排程：尚無排程任務")
        else:
            # 從佇列中找出「執行時間最早」的任務，這就是目前最接近觸發的排程
            nearest_task = min(self.scheduled_tasks, key=lambda t: t["target_dt"])
            remaining = (nearest_task["target_dt"] - datetime.now()).total_seconds()

            if remaining > 0:
                # 格式化剩餘秒數為「時:分:秒」
                total_seconds = int(remaining)
                hours, rem = divmod(total_seconds, 3600)
                minutes, seconds = divmod(rem, 60)
                self.label_schedule_countdown.config(
                    text=f"距離最近排程還有 {hours:02d}:{minutes:02d}:{seconds:02d}"
                         f"（將於 {nearest_task['target_dt'].strftime('%H:%M:%S')} 執行）"
                )
            else:
                # remaining <= 0 只代表「這筆任務的目標時間已經到了」，
                # 不代表背景真的有執行緒在跑——如果使用者根本還沒按「啟動排程佇列」，
                # 或是佇列已經被停止/跑完，時間到了也不會有任何動作發生。
                # 這裡務必用 self.is_playing 分辨這兩種情況，
                # 否則會讓使用者誤以為「顯示執行中 = 滑鼠正在動作」，
                # 但其實背景根本沒有執行緒在運作，看起來就像「排程卡住沒反應」。
                if self.is_playing:
                    self.label_schedule_countdown.config(text="最近的排程任務正在執行中...")
                else:
                    self.label_schedule_countdown.config(
                        text="⚠ 任務時間已到，但尚未啟動！請按下「▶ 啟動排程佇列」"
                    )

        # 每 500 毫秒更新一次，數字用秒為單位，這個更新頻率已經足夠流暢
        self.root.after(500, self._update_schedule_countdown)

    # ==================================================================
    # 記錄座標相關功能
    # ==================================================================
    def show_key_reference(self):
        """
        開啟一個獨立的小視窗 (Toplevel)，顯示 pyautogui 支援的按鍵名稱對照表，
        依「數字」「英文字母」「常用符號」「功能鍵」「方向鍵」「特殊/修飾鍵」分類，
        方便使用者填寫上方的「按鍵/組合鍵」輸入框時直接查閱，不用去翻官方文件。

        注意：這份清單是 pyautogui 內建對應「美式鍵盤佈局 (US QWERTY)」的鍵名，
             符號鍵是否正確，會受 Windows 系統目前的鍵盤佈局影響。
        """
        # tk.Toplevel：建立一個「額外的視窗」，獨立於主視窗之外，
        # 但仍然屬於同一個應用程式（關閉主視窗時，這種子視窗也會一併消失）。
        window = tk.Toplevel(self.root)
        window.title("按鍵名稱對照表（pyautogui）")
        window.geometry("420x520")

        # Text 元件用來顯示大量文字內容，搭配捲軸方便瀏覽
        text_widget = tk.Text(window, font=("Consolas", 10), wrap="word")
        text_widget.pack(side="left", fill="both", expand=True)

        scrollbar = tk.Scrollbar(window, orient="vertical", command=text_widget.yview)
        scrollbar.pack(side="right", fill="y")
        text_widget.config(yscrollcommand=scrollbar.set)

        # ------------------------------------------------------------
        # 按鍵名稱清單，依類別整理。
        # 這些名稱直接對應 pyautogui 內部的 KEYBOARD_KEYS 清單，
        # 填在「按鍵/組合鍵」輸入框裡時，打法要完全一致（英文小寫）。
        # ------------------------------------------------------------
        reference_text = """
【數字鍵】直接打數字本身即可
0 1 2 3 4 5 6 7 8 9

【英文字母】直接打字母本身即可（大小寫效果相同，皆為小寫按鍵）
a b c d e f g h i j k l m n o p q r s t u v w x y z

【常用符號】直接打符號本身，pyautogui 會自動處理是否需要按 Shift
!  "  #  $  %  &  '  (  )  *  +  ,  -  .  /
:  ;  <  =  >  ?  @  [  \\  ]  ^  _  `
{  |  }  ~

【功能鍵】
f1  f2  f3  f4  f5  f6  f7  f8  f9  f10  f11  f12
f13 f14 f15 f16 f17 f18 f19 f20 f21 f22 f23 f24

【方向鍵】
up      （上）
down    （下）
left    （左）
right   （右）

【常用特殊鍵】
enter / return   （Enter 鍵）
esc / escape     （Esc 鍵）
tab              （Tab 鍵）
space            （空白鍵）
backspace        （倒退鍵）
delete / del     （Delete 鍵）
home             （Home 鍵）
end              （End 鍵）
pageup / pgup    （Page Up）
pagedown / pgdn  （Page Down）
insert           （Insert 鍵）
capslock         （大寫鎖定）
printscreen      （螢幕截圖 PrtScn）

【修飾鍵（通常搭配組合鍵使用，如 ctrl+c）】
ctrl  / ctrlleft  / ctrlright
alt   / altleft   / altright
shift / shiftleft / shiftright
win   / winleft   / winright   （Windows 鍵）

【多媒體鍵】
volumeup  volumedown  volumemute
playpause  nexttrack  prevtrack

------------------------------------------------------------
組合鍵寫法：用「+」分隔多個鍵名，例如：
    ctrl+c        複製
    ctrl+v        貼上
    ctrl+z        復原
    ctrl+s        儲存
    alt+tab       切換視窗
    ctrl+shift+esc  開啟工作管理員
    win+d         顯示桌面

提醒：符號鍵的對應是基於美式鍵盤佈局，
     若 Windows 目前輸入法/鍵盤佈局不是美式，實際打出的符號可能不同，
     建議先用單一符號測試過一次再放進正式的自動化流程。
"""
        text_widget.insert("1.0", reference_text.strip())
        text_widget.config(state="disabled")  # 設為唯讀，避免使用者誤改內容

    def record_point(self):
        """
        將「目前滑鼠位置」加入事件清單，並顯示在 Listbox 中。

        資料結構說明：
            清單裡現在有兩種事件類型，用 "type" 欄位分辨：

            座標點事件：
                {"type": "point", "x": 100, "y": 200, "click_type": "left", "key": "ctrl+c"}
            快速連按事件：
                {"type": "rapid_click", "rate": 10, "count": 20, "button_type": "left"}

        插入位置：如果 Listbox 裡目前有選取項目，新記錄的座標點會插入到
        「選取項目的下一個位置」，方便把新座標點安插在中間；
        沒有選取任何項目時，就加到清單最後面（原本的行為）。
        """
        x, y = pyautogui.position()  # 抓取目前座標

        # 讀取「滑鼠動作」單選鈕目前選中的值：left / right / none
        click_type = self.click_type_var.get()

        # 讀取「按鍵/組合鍵」輸入框目前的內容。
        # .strip() 去除頭尾空白；若使用者沒填，會是空字串 ""。
        key_text = self.entry_key.get().strip()
        key_value = key_text if key_text else None  # 空字串一律轉成 None，代表「沒有按鍵」

        event = {"type": "point", "x": x, "y": y, "click_type": click_type, "key": key_value}

        # 依「目前是否有選取項目」決定插入位置
        selection = self.listbox_points.curselection()
        if selection:
            insert_index = selection[0] + 1
            self.recorded_points.insert(insert_index, event)
        else:
            self.recorded_points.append(event)

        self._refresh_listbox_labels()

        click_label = {"left": "左鍵點擊", "right": "右鍵點擊", "none": "不點擊"}[click_type]
        if key_value:
            self._set_status(f"已記錄座標點：({x}, {y})，{click_label}，附加按鍵：{key_value}")
        else:
            self._set_status(f"已記錄座標點：({x}, {y})，{click_label}")

    @staticmethod
    def _format_event_label(index, event):
        """
        統一產生 Listbox 中每一列的顯示文字，依事件類型分別格式化，
        獨立成一個函式方便 record_point() / insert_rapid_click_event() /
        _refresh_listbox_labels() 共用，避免各處格式寫法不一致。
        """
        if event["type"] == "rapid_click":
            button_label = "左鍵" if event["button_type"] == "left" else "右鍵"
            return (
                f"事件 {index}：⚡ 快速連按 {button_label}，"
                f"每秒 {event['rate']} 次，共 {event['count']} 次"
            )

        # event["type"] == "point"
        x, y = event["x"], event["y"]
        click_type = event.get("click_type", "left")
        key_value = event["key"]
        click_label = {"left": "左鍵", "right": "右鍵", "none": "不點擊"}.get(click_type, "左鍵")
        label = f"點 {index}：({x}, {y})  [{click_label}]"
        if key_value:
            label += f"  [按鍵: {key_value}]"
        return label

    def delete_selected_point(self):
        """
        刪除使用者在 Listbox 中選取的項目（座標點或快速連按事件皆可）。
        """
        selection = self.listbox_points.curselection()  # 取得目前選取的項目 index（tuple）
        if not selection:
            messagebox.showinfo("提示", "請先在清單中選取要刪除的項目")
            return

        index = selection[0]  # curselection 回傳 tuple，取第一個即可（單選模式）
        del self.recorded_points[index]        # 從資料清單中移除
        self._refresh_listbox_labels()         # 重新編號並重畫剩餘的項目
        self._set_status("已刪除選取的項目")

    def clear_all_points(self):
        """
        清空所有已記錄的事件（座標點與快速連按事件都會被清空）。
        """
        if not self.recorded_points:
            return
        self.recorded_points.clear()
        self.listbox_points.delete(0, tk.END)  # 清空 Listbox 所有項目
        self._set_status("已清空所有項目")

    def _refresh_listbox_labels(self):
        """
        新增/刪除/插入事件後，重新產生 Listbox 的顯示文字，
        讓「點 1、事件 2、點 3...」的編號保持連續正確。
        """
        self.listbox_points.delete(0, tk.END)
        for i, event in enumerate(self.recorded_points, start=1):
            self.listbox_points.insert(tk.END, self._format_event_label(i, event))

    def insert_rapid_click_event(self):
        """
        按下「➕ 插入快速連按事件到清單」時呼叫。

        把目前「快速連按」區塊設定的速率/次數/按鍵，包成一筆「快速連按事件」，
        插入到事件清單裡——插入位置規則跟 record_point() 一致：
        Listbox 有選取項目就插到選取項目的下一個位置，沒有就加到最後面。

        這個事件在播放時，會在「當下滑鼠所在位置」
        （也就是清單中前一步移動到的位置）連續點擊，
        執行完才會繼續往清單下一筆走，藉此達成「插在任兩個座標點中間」的效果。
        """
        rate = self.scale_rapid_rate.get()

        try:
            click_count = int(self.spin_rapid_count.get())
            if click_count < 1:
                raise ValueError
        except ValueError:
            messagebox.showerror("錯誤", "總點擊次數必須是大於等於 1 的整數")
            return

        button_type = self.rapid_click_button_var.get()  # "left" 或 "right"

        event = {"type": "rapid_click", "rate": rate, "count": click_count, "button_type": button_type}

        selection = self.listbox_points.curselection()
        if selection:
            insert_index = selection[0] + 1
            self.recorded_points.insert(insert_index, event)
        else:
            self.recorded_points.append(event)

        self._refresh_listbox_labels()

        button_label = "左鍵" if button_type == "left" else "右鍵"
        self._set_status(f"已插入快速連按事件：{button_label}，每秒 {rate} 次，共 {click_count} 次")

    # ==================================================================
    # 播放（自動移動 + 點擊）相關功能
    # ==================================================================
    def start_playback(self):
        """
        按下「開始播放」時呼叫。
        真正的移動/點擊邏輯放在背景執行緒 (threading.Thread) 執行，
        原因：如果直接在主執行緒跑迴圈，Tkinter 的視窗畫面會「卡住」無法更新，
             使用者也按不到「停止」按鈕。
        """
        if self.is_playing:
            messagebox.showinfo("提示", "目前正在播放中")
            return

        if not self.recorded_points:
            messagebox.showwarning("提示", "尚未記錄任何座標點，請先記錄座標")
            return

        self.is_playing = True
        self.stop_requested = False
        self._set_status("播放中...（可按下停止按鈕中斷）")

        # 建立一個背景執行緒來跑 _playback_worker，
        # daemon=True 表示：若主視窗被關閉，這個執行緒也會跟著結束，不會卡住程式退出。
        thread = threading.Thread(target=self._playback_worker, daemon=True)
        thread.start()

    def _run_trajectory_loop(self, speed, click_delay, wait_time):
        """
        依序執行事件清單裡的每一筆事件——清單裡有兩種事件類型：
            "point"       —— 移動滑鼠到座標 -> 點擊觸發間隔 -> 點擊 -> (選填)按鍵 -> 停留
            "rapid_click" —— 在「當下滑鼠所在位置」原地連續點擊指定次數 -> 停留

        這段邏輯被抽成獨立函式，是因為「一般播放」(F9/按鈕) 跟「排程模式」
        都需要跑同一套動作——排程模式甚至要重複跑好幾遍——
        把核心邏輯抽出來共用，可以避免兩個地方各寫一份、日後改一次卻忘記改另一邊。

        參數說明：
            speed       —— 移動到定位所花的秒數（越小越快），只影響 "point" 事件
            click_delay —— 定位完成後，要再等多久才觸發點擊，只影響 "point" 事件
            wait_time   —— 該筆事件的動作都完成後，停留多久才前往下一筆事件
                           （用來等待畫面反應、頁面載入，可以拉到幾十秒，兩種事件都適用）

        回傳值：
            "completed" —— 所有事件都正常跑完
            "stopped"   —— 途中被使用者按下停止而中斷

        注意：這個函式本身「不」處理 pyautogui.FailSafeException，
             刻意讓例外往外拋出，由呼叫端（_playback_worker / _multi_schedule_worker）
             自行決定發生 FAILSAFE 時要怎麼處理（例如排程模式遇到 FAILSAFE
             應該整個排程都中止，而不是只中止當次重複）。
        """
        for i, event in enumerate(self.recorded_points, start=1):
            # 每次動作前先檢查使用者是否按下了「停止」
            if self.stop_requested:
                self._set_status("播放已被使用者中止")
                return "stopped"

            # ------------------------------------------------------
            # 快速連按事件：不移動滑鼠，直接在目前位置連續點擊。
            # 呼叫跟「⚡ 開始快速連按」共用的 _execute_rapid_click()，
            # 避免同一套連按邏輯在兩個地方各寫一份。
            # ------------------------------------------------------
            if event["type"] == "rapid_click":
                self._set_status(f"第 {i} 項：執行快速連按（共 {event['count']} 次）...")
                result = self._execute_rapid_click(event["rate"], event["count"], event["button_type"])
                if result == "stopped":
                    return "stopped"

                # 跟座標點一樣，動作完成後停留 wait_time 秒再前往下一筆事件，
                # 讓「插在中間的快速連按」跟前後的座標點使用同一套節奏設定。
                time.sleep(wait_time)
                self._set_status(f"已完成第 {i} 項的快速連按")
                continue  # 跳過下面「座標點」專屬的邏輯，直接處理下一筆事件

            # ------------------------------------------------------
            # 座標點事件（event["type"] == "point"）
            # ------------------------------------------------------
            x, y = event["x"], event["y"]
            click_type = event.get("click_type", "left")  # 用 .get() 給預設值，避免舊資料沒有這個欄位時出錯
            key_value = event["key"]

            self._set_status(f"移動到第 {i} 點：({x}, {y}) ...")

            # ------------------------------------------------------
            # pyautogui.moveTo(x, y, duration)：
            #   將滑鼠從目前位置「平滑移動」到指定座標 (x, y)。
            #   duration 參數控制移動所花費的時間（秒），
            #   數值越大，移動軌跡越像人手操作的漸進移動；
            #   數值為 0 則是瞬間跳到該座標。
            #
            # 底層原理：pyautogui 會把 (目前座標) 到 (目標座標) 之間
            #   拆成很多小步驟，每一小步呼叫一次 Win32 的 SetCursorPos，
            #   搭配極短暫的 sleep，讓畫面上看起來像是平滑移動。
            #
            # 重點修正：duration 是「這次移動固定要花的時間」，
            #   跟「移動距離」完全無關——就算目標座標跟目前滑鼠位置一模一樣
            #   （例如連續兩個點都是同一個座標，只是想在原地重複點擊/按鍵），
            #   pyautogui 還是會乖乖把 duration 秒的時間全部睡完，才繼續往下走，
            #   這正是「座標沒變、間隔卻還是被移動速度拖慢」的原因。
            #   這裡先查詢目前滑鼠實際位置，如果跟目標座標相同就完全跳過
            #   moveTo()，不套用任何動畫時間，直接進入下一步。
            # ------------------------------------------------------
            current_x, current_y = pyautogui.position()
            if (current_x, current_y) != (x, y):
                pyautogui.moveTo(x, y, duration=speed)
            # 座標相同時，滑鼠本來就已經在那裡了，不需要移動也不需要套用 duration

            # 再次檢查是否被要求停止（因為移動需要時間，移動完後可能使用者已按停止）
            if self.stop_requested:
                self._set_status("播放已被使用者中止")
                return "stopped"

            # 定位完成後，先等待「點擊觸發間隔」（預設 0.5 秒，可自行調整）。
            # 這個等待跟下面的 wait_time 是分開的兩個獨立設定，
            # 前者控制「多快觸發動作」，後者控制「動作完後停留多久才前進下一點」。
            # 就算這個點選擇「不點擊」，還是保留這段等待，讓「定位 -> 動作」的節奏維持一致
            # （例如只想按鍵不點擊時，通常也需要先讓目標視窗有時間反應游標移動過去這件事）。
            time.sleep(click_delay)

            # ------------------------------------------------------
            # pyautogui.click(button=...)：
            #   在「目前滑鼠位置」執行一次點擊，button 參數決定是哪一個滑鼠鍵：
            #   'left' 對應左鍵、'right' 對應右鍵（pyautogui 也還有 'middle' 對應中鍵）。
            #
            #   底層原理：不管左鍵右鍵，Windows 的訊息機制是對稱的——
            #   左鍵送出的是 WM_LBUTTONDOWN / WM_LBUTTONUP，
            #   右鍵送出的則是 WM_RBUTTONDOWN / WM_RBUTTONUP，
            #   pyautogui 只是依 button 參數決定呼叫哪一組事件，事件產生的機制完全相同。
            #
            #   如果這個座標點設定為「不點擊」(click_type == "none")，
            #   就完全跳過這一步，滑鼠只移動過去，不觸發任何點擊——
            #   適合搭配下面的按鍵欄位，做出「只按鍵、不點滑鼠」的動作。
            # ------------------------------------------------------
            if click_type in ("left", "right"):
                pyautogui.click(button=click_type)
            # click_type == "none" 時，這裡什麼都不做，直接跳到下面的按鍵判斷

            # ------------------------------------------------------
            # 如果這個座標點有附加「按鍵/組合鍵」設定，接著模擬（不論上面有沒有點擊）。
            #
            # 底層原理：
            #   pyautogui.press('enter') 這類單鍵，內部是把按鍵名稱
            #   對應成 Windows 的虛擬鍵碼 (Virtual-Key Code)，
            #   透過 SendInput 送出一組「按下 + 放開」事件。
            #
            #   pyautogui.hotkey('ctrl', 'c') 這類組合鍵，
            #   則是依序「按下」每個鍵（ctrl 按下 -> c 按下），
            #   再用「相反順序」依序放開（c 放開 -> ctrl 放開）。
            #   這跟真人按組合鍵的動作完全一致：
            #   必須先「按住」修飾鍵（ctrl/alt/shift），
            #   系統才會把後面按下的鍵解讀成「該修飾鍵 + 該鍵」的組合，
            #   若同時放開或順序錯誤，可能就不會被目標視窗判定為組合鍵。
            # ------------------------------------------------------
            if key_value:
                self._set_status(f"第 {i} 點模擬按鍵：{key_value} ...")
                try:
                    key_parts = [k.strip().lower() for k in key_value.split("+") if k.strip()]
                    if len(key_parts) == 1:
                        pyautogui.press(key_parts[0])   # 單一按鍵
                    elif len(key_parts) > 1:
                        pyautogui.hotkey(*key_parts)    # 組合鍵（依序按下、反序放開）
                except Exception as key_err:
                    # 按鍵名稱可能打錯（例如 pyautogui 不認得的鍵名），
                    # 這裡攔截例外並顯示狀態，不讓整個播放流程中斷。
                    self._set_status(f"第 {i} 點按鍵模擬失敗：{key_err}")

            # 動作都完成後，停留 wait_time 秒再前往下一點，
            # 這是原本「到達後停留秒數」的用途，現在改成發生在動作「之後」。
            time.sleep(wait_time)

            self._set_status(f"已完成第 {i} 點的動作")

        # for 迴圈正常跑完（沒有中途 return "stopped"），代表整條軌跡都執行完成
        return "completed"

    def _playback_worker(self):
        """
        「一般播放」(F9 / 按鈕觸發) 的執行緒進入點。
        只負責：設定狀態 -> 呼叫共用的 _run_trajectory_loop 跑一次 -> 處理例外 -> 收尾。
        這個函式在背景執行緒中執行，不會阻塞 GUI。
        """
        speed = self.scale_speed.get()  # 取得使用者設定的移動秒數（速度）
        click_delay = self.scale_click_delay.get()  # 取得使用者設定的點擊觸發間隔
        wait_time = self.scale_wait.get()  # 取得使用者設定的點擊後停留秒數

        try:
            result = self._run_trajectory_loop(speed, click_delay, wait_time)
            if result == "completed":
                self._set_status("所有座標點播放完成 ✅")

        except pyautogui.FailSafeException:
            # ----------------------------------------------------------
            # 【安全機制觸發】
            # 當使用者把滑鼠快速移到螢幕左上角 (0,0) 時，
            # pyautogui 偵測到這個位置，下一次呼叫 moveTo/click 等函式
            # 就會拋出 FailSafeException，中斷所有後續動作。
            # ----------------------------------------------------------
            self._set_status("⚠ 觸發 FAILSAFE 安全機制！已立即停止所有滑鼠操作")

        finally:
            # 不論播放是正常結束、被使用者停止、還是被 FAILSAFE 中斷，
            # 都要把狀態重置回「未播放」，讓使用者可以再次按下開始播放。
            self.is_playing = False

    def stop_playback(self):
        """
        按下「停止」按鈕時呼叫。
        只是把 stop_requested 設成 True，
        真正的中止動作是由 _run_trajectory_loop / _multi_schedule_worker /
        _rapid_click_worker 裡的迴圈自行檢查後跳出。
        （這是執行緒安全的做法，不直接強制殺掉執行緒）

        這個函式同時服務三種情境：
            1. 一般播放中 —— 中斷目前正在跑的軌跡
            2. 排程等待或執行中 —— 取消倒數，或中斷正在重複執行的軌跡
            3. 快速連按中 —— 中斷連續點擊
        三者都是靠 self.is_playing / self.stop_requested 這兩個共用旗標判斷，
        所以不需要另外幫每種功能各寫一個「停止」函式。
        """
        if not self.is_playing:
            self._set_status("目前沒有正在播放、排程或連按中的動作")
            return
        self.stop_requested = True
        self._set_status("已送出停止指令，等待目前動作中止...")

    # ==================================================================
    # 快速連按（在目前滑鼠位置，以指定速率連續點擊）
    # ==================================================================
    def start_rapid_click(self):
        """
        按下「⚡ 開始快速連按」(或 F11) 時呼叫。
        跟「播放」不同的地方：這裡完全不使用 self.recorded_points，
        只是在「當下滑鼠所在的位置」原地連續點擊，不會移動滑鼠。
        """
        if self.is_playing:
            messagebox.showinfo("提示", "目前已有播放、排程或連按正在進行中，請先停止")
            return

        rate = self.scale_rapid_rate.get()  # 每秒點擊次數

        try:
            click_count = int(self.spin_rapid_count.get())
            if click_count < 1:
                raise ValueError
        except ValueError:
            messagebox.showerror("錯誤", "總點擊次數必須是大於等於 1 的整數")
            return

        button_type = self.rapid_click_button_var.get()  # "left" 或 "right"

        self.is_playing = True
        self.stop_requested = False

        button_label = "左鍵" if button_type == "left" else "右鍵"
        self._set_status(f"快速連按已啟動：{button_label}，每秒 {rate} 次，共 {click_count} 次")

        thread = threading.Thread(
            target=self._rapid_click_worker,
            args=(rate, click_count, button_type),
            daemon=True
        )
        thread.start()

    def _rapid_click_worker(self, rate, click_count, button_type):
        """
        「⚡ 開始快速連按」(F11 / 按鈕，獨立觸發) 的執行緒進入點。
        只負責：呼叫共用的 _execute_rapid_click() 執行一次 -> 處理例外 -> 收尾。
        跟 _playback_worker 是同樣的分工模式：核心邏輯共用，這裡只管背景執行緒的生命週期。
        """
        try:
            result = self._execute_rapid_click(rate, click_count, button_type)
            if result == "completed":
                self._set_status(f"快速連按完成，共點擊 {click_count} 次 ✅")

        except pyautogui.FailSafeException:
            self._set_status("⚠ 觸發 FAILSAFE 安全機制！快速連按已立即停止")

        finally:
            self.is_playing = False

    def _execute_rapid_click(self, rate, click_count, button_type):
        """
        快速連按的核心邏輯，供兩個地方共用：
            1. _rapid_click_worker —— 獨立觸發（F11 / 按鈕），立刻在目前滑鼠位置執行
            2. _run_trajectory_loop —— 事件清單裡的「快速連按事件」，
               在清單跑到這一筆時，於當下滑鼠位置執行

        原理很單純：不呼叫 pyautogui.moveTo()（滑鼠完全不動），
        只是照著「每秒 rate 次」換算出的間隔時間，重複呼叫 pyautogui.click()。

        例如 rate=10（每秒 10 次），換算下來每次點擊間隔 1/10 = 0.1 秒。
        這個間隔是「兩次點擊之間」的休息時間，不是點擊本身花的時間——
        點擊動作（按下+放開）本身非常快，可以忽略不計。

        注意：實際能達到的點擊速率仍然受限於：
            1. Windows 處理輸入事件的速度
            2. 目標應用程式讀取/回應點擊事件的速度
        設定 50 次/秒不代表目標程式一定來得及反應每一次點擊。

        回傳值：
            "completed" —— click_count 次全部正常跑完
            "stopped"   —— 途中被使用者按下停止而中斷

        注意：這個函式本身「不」處理 pyautogui.FailSafeException，
             刻意讓例外往外拋出，交由呼叫端（_rapid_click_worker /
             _playback_worker / _multi_schedule_worker）統一處理，
             這跟 _run_trajectory_loop 是同樣的設計原則。
        """
        interval = 1.0 / rate if rate > 0 else 0

        for i in range(1, click_count + 1):
            if self.stop_requested:
                self._set_status("快速連按已被使用者中止")
                return "stopped"

            pyautogui.click(button=button_type)
            self._set_status(f"快速連按中：第 {i}/{click_count} 次")

            # 最後一次點擊完就不用再等了，直接結束
            if i < click_count:
                time.sleep(interval)

        return "completed"

    # ==================================================================
    # 排程模式（多任務佇列：設定特定時間 + 重複執行次數 + 間隔秒數）
    # ==================================================================
    def _parse_schedule_time(self, time_text):
        """
        共用的時間字串解析函式，回傳計算好的目標 datetime，
        或者在格式錯誤時回傳 None（呼叫端自行決定要不要跳出錯誤訊息）。

        依「冒號數量」判斷使用者填的是 HH:MM 還是 HH:MM:SS，兩種格式都接受；
        若解析出的時間已經過去，自動視為「明天的這個時間」。
        """
        target_time = None
        for fmt in ("%H:%M:%S", "%H:%M"):
            try:
                target_time = datetime.strptime(time_text, fmt).time()
                break
            except ValueError:
                continue

        if target_time is None:
            return None

        now = datetime.now()
        target_dt = datetime.combine(now.date(), target_time)
        if target_dt <= now:
            target_dt += timedelta(days=1)
        return target_dt

    def add_schedule_task(self):
        """
        按下「➕ 新增排程任務」時呼叫。
        只負責把目前設定的「時間 / 重複次數 / 間隔秒數」包成一筆任務，
        加進 self.scheduled_tasks 佇列並更新畫面清單——不會立刻開始倒數。
        """
        if self.is_playing:
            messagebox.showinfo("提示", "排程佇列執行中，無法新增任務，請先按停止")
            return

        time_text = self.entry_schedule_time.get().strip()
        target_dt = self._parse_schedule_time(time_text)
        if target_dt is None:
            messagebox.showerror(
                "錯誤", "時間格式錯誤，請輸入 HH:MM 或 HH:MM:SS，例如 14:30 或 14:30:00"
            )
            return

        try:
            repeat_count = int(self.spin_repeat.get())
            if repeat_count < 1:
                raise ValueError
        except ValueError:
            messagebox.showerror("錯誤", "重複執行次數必須是大於等於 1 的整數")
            return

        interval = self.scale_interval.get()  # 每次重複之間的間隔秒數（0.1 秒為單位）

        task = {"target_dt": target_dt, "repeat_count": repeat_count, "interval": interval}
        self.scheduled_tasks.append(task)
        self._refresh_schedule_listbox()

        self._set_status(
            f"已新增排程任務：{target_dt.strftime('%Y-%m-%d %H:%M:%S')}，"
            f"重複 {repeat_count} 次（間隔 {interval:.1f} 秒）"
        )

    def _refresh_schedule_listbox(self):
        """
        依「執行時間」由早到晚排序後，重新畫出整個排程任務清單。
        任何新增/刪除/清空/執行完成的動作之後都要呼叫這個函式來同步畫面。
        """
        self.listbox_schedule.delete(0, tk.END)
        sorted_tasks = sorted(self.scheduled_tasks, key=lambda t: t["target_dt"])
        for i, task in enumerate(sorted_tasks, start=1):
            self.listbox_schedule.insert(
                tk.END,
                f"任務 {i}：{task['target_dt'].strftime('%Y-%m-%d %H:%M:%S')}，"
                f"重複 {task['repeat_count']} 次（間隔 {task['interval']:.1f} 秒）"
            )

    def delete_selected_task(self):
        """
        刪除使用者在排程佇列清單中選取的任務。
        """
        if self.is_playing:
            messagebox.showinfo("提示", "排程佇列執行中，無法刪除任務，請先按停止")
            return

        selection = self.listbox_schedule.curselection()
        if not selection:
            messagebox.showinfo("提示", "請先在排程任務清單中選取要刪除的任務")
            return

        # 清單顯示是「依時間排序過」的順序，所以要用同樣排序過的清單來對應被選到的任務，
        # 而不是直接用 self.scheduled_tasks 原本新增時的順序（兩者可能不一致）。
        sorted_tasks = sorted(self.scheduled_tasks, key=lambda t: t["target_dt"])
        target_task = sorted_tasks[selection[0]]
        self.scheduled_tasks.remove(target_task)
        self._refresh_schedule_listbox()
        self._set_status("已刪除選取的排程任務")

    def clear_all_tasks(self):
        """
        清空所有排程任務。
        """
        if self.is_playing:
            messagebox.showinfo("提示", "排程佇列執行中，無法清空任務，請先按停止")
            return
        if not self.scheduled_tasks:
            return
        self.scheduled_tasks.clear()
        self._refresh_schedule_listbox()
        self._set_status("已清空所有排程任務")

    def start_schedule_queue(self):
        """
        按下「▶ 啟動排程佇列」時呼叫。
        開一個背景執行緒 (_multi_schedule_worker)，依序處理佇列裡的每一筆任務。
        """
        if self.is_playing:
            messagebox.showinfo("提示", "目前已有播放或排程正在進行中，請先停止後再啟動")
            return

        if not self.scheduled_tasks:
            messagebox.showwarning("提示", "排程佇列是空的，請先新增至少一筆排程任務")
            return

        if not self.recorded_points:
            messagebox.showwarning("提示", "尚未記錄任何座標點，請先記錄座標")
            return

        self.is_playing = True
        self.is_scheduling = True
        self.stop_requested = False

        self._set_status(f"排程佇列已啟動，共有 {len(self.scheduled_tasks)} 個任務等待執行")

        thread = threading.Thread(target=self._multi_schedule_worker, daemon=True)
        thread.start()

    def _multi_schedule_worker(self):
        """
        排程佇列的背景執行緒進入點。
        每一輪都從目前佇列中挑出「執行時間最早」的一筆任務來處理，分兩階段：
            階段一：倒數等待，直到系統時間到達該任務的 target_dt
            階段二：重複呼叫 _run_trajectory_loop() repeat_count 次，每次之間停留 interval 秒
        該任務處理完（或被中止）後就從佇列移除，接著繼續處理下一筆，
        直到佇列清空，或使用者按下停止為止。

        全程都會頻繁檢查 self.stop_requested，讓使用者隨時可以用
        「⏹ 停止 (F10)」中斷倒數或執行。
        """
        speed = self.scale_speed.get()
        click_delay = self.scale_click_delay.get()
        wait_time = self.scale_wait.get()

        try:
            while self.scheduled_tasks:
                if self.stop_requested:
                    self._set_status("排程佇列已被使用者取消")
                    return

                # 每一輪都重新挑選「執行時間最早」的任務，
                # 這樣就算執行過程中前面任務拖得比較久，也一定會照時間順序處理。
                task = min(self.scheduled_tasks, key=lambda t: t["target_dt"])
                target_dt = task["target_dt"]
                repeat_count = task["repeat_count"]
                interval = task["interval"]

                # ---------------- 階段一：倒數等待 ----------------
                while True:
                    if self.stop_requested:
                        self._set_status("排程佇列已被使用者取消")
                        return

                    now = datetime.now()
                    remaining = (target_dt - now).total_seconds()
                    if remaining <= 0:
                        break  # 時間到了，跳出等待迴圈，進入執行階段

                    total_seconds = int(remaining)
                    hours, rem = divmod(total_seconds, 3600)
                    minutes, seconds = divmod(rem, 60)
                    self._set_status(
                        f"排程等待中，下一個任務將於 {target_dt.strftime('%H:%M:%S')} 執行"
                        f"（倒數 {hours:02d}:{minutes:02d}:{seconds:02d}，"
                        f"佇列剩餘 {len(self.scheduled_tasks)} 個任務）"
                    )
                    time.sleep(min(1.0, remaining))

                # ---------------- 階段二：重複執行 repeat_count 次 ----------------
                task_stopped = False
                for rep in range(1, repeat_count + 1):
                    if self.stop_requested:
                        self._set_status("排程佇列已被使用者中止")
                        task_stopped = True
                        break

                    self._set_status(f"執行任務中：第 {rep}/{repeat_count} 次")
                    result = self._run_trajectory_loop(speed, click_delay, wait_time)

                    if result == "stopped":
                        task_stopped = True
                        break

                    if rep < repeat_count and interval > 0:
                        waited = 0.0
                        while waited < interval:
                            if self.stop_requested:
                                break
                            step = min(1.0, interval - waited)
                            time.sleep(step)
                            waited += step
                        if self.stop_requested:
                            self._set_status("排程佇列已被使用者中止")
                            task_stopped = True
                            break

                if task_stopped:
                    return  # 使用者中止，整個佇列都不再繼續

                # 這筆任務正常執行完成，立刻從佇列移除（同步進行，不能用 root.after 排隊）。
                #
                # 重要：這裡故意不用 self.root.after(0, self._remove_completed_task, task)——
                # after() 只是把移除動作排進主執行緒的事件佇列，不會馬上執行。
                # 如果這裡讓背景執行緒不等待就直接跳回 while 迴圈重新挑任務，
                # 主執行緒可能還沒處理完那個排隊的移除動作，
                # 導致這一筆「其實已經執行完」的任務還留在 self.scheduled_tasks 裡，
                # 又被 min() 挑出來重複執行一次——這就是排程會卡住重複執行的原因。
                #
                # 修法：list.remove() 這種單純的串列操作在 CPython 裡受 GIL 保護，
                # 直接在背景執行緒同步執行是安全的；只有「更新 Listbox 畫面」這種
                # 真正牽涉 Tkinter 元件的動作，才需要透過 root.after() 排回主執行緒。
                if task in self.scheduled_tasks:
                    self.scheduled_tasks.remove(task)
                self.root.after(0, self._refresh_schedule_listbox)

            self._set_status("所有排程任務皆已完成 ✅")

        except pyautogui.FailSafeException:
            # 排程執行期間若觸發 FAILSAFE，整個佇列直接中止，不會再繼續下一筆任務
            self._set_status("⚠ 觸發 FAILSAFE 安全機制！排程佇列已立即中止")

        finally:
            self.is_playing = False
            self.is_scheduling = False

    # ==================================================================
    # 全域快捷鍵（F8 記錄 / F9 播放 / F10 停止 / F11 快速連按）
    # ==================================================================
    def _start_hotkey_listener(self):
        """
        啟動一個「背景執行緒」，用 pynput 監聽全系統的鍵盤事件。

        原理說明：
            pynput.keyboard.Listener 在 Windows 上內部會呼叫
            ctypes -> user32.dll -> SetWindowsHookEx(WH_KEYBOARD_LL, callback, ...)，
            這是一種「低階鍵盤鉤子」，會安裝在系統的鍵盤事件處理流程中。
            每當任何按鍵被按下（不管焦點在哪個視窗），
            Windows 都會先呼叫我們註冊的 callback 函式，
            所以即使我們的 Tkinter 視窗完全沒有焦點，也能收到按鍵事件。

            這跟 Tkinter 的 root.bind("<F8>", ...) 完全不同 ——
            bind() 只有在「這個 Tkinter 視窗」是目前作業系統的焦點視窗時才有效。
        """
        # Listener 建立時傳入 on_press callback，每次「按下」按鍵都會呼叫一次
        self.hotkey_listener = pynput_keyboard.Listener(on_press=self._on_key_press)

        # Listener 內部本身就是一個獨立的背景執行緒在運作（daemon 執行緒），
        # 呼叫 .start() 之後主程式會立刻繼續往下執行，不會被卡住。
        self.hotkey_listener.start()

    def _on_key_press(self, key):
        """
        每當偵測到「任何一個按鍵被按下」時，pynput 都會呼叫這個函式。
        參數 key 是 pynput 定義的按鍵物件，例如 Key.f8、Key.f9 等特殊鍵，
        一般文字鍵則會是 KeyCode 物件（例如按 'a' 會是 KeyCode(char='a')）。

        重要：這個函式是在 pynput 自己的背景執行緒中被呼叫，
             而 Tkinter 的元件（Label、Button...）只能在「主執行緒」安全地更新，
             所以這裡不能直接呼叫 self.record_point() 等函式，
             而是要透過 self.root.after(0, func) 把工作「排程」回主執行緒執行。
             這是所有 GUI 框架（Tkinter、Qt、WinForms...）共通的「執行緒安全」規則。
        """
        try:
            if key == pynput_keyboard.Key.f8:
                # F8：記錄目前滑鼠座標
                self.root.after(0, self.record_point)

            elif key == pynput_keyboard.Key.f9:
                # F9：開始播放
                self.root.after(0, self.start_playback)

            elif key == pynput_keyboard.Key.f10:
                # F10：停止播放
                self.root.after(0, self.stop_playback)

            elif key == pynput_keyboard.Key.f11:
                # F11：在目前滑鼠位置開始快速連按
                self.root.after(0, self.start_rapid_click)

        except Exception:
            # 這裡刻意攔截所有例外（而不是只攔截 RuntimeError）。
            #
            # 原因：這個函式是 pynput 背景監聽執行緒的 callback，
            # 如果裡面丟出「任何」沒被攔截的例外，會導致 pynput 的監聽執行緒
            # 整個當掉、停止運作——後果是 F8/F9/F10/F11 全部一起失效，
            # 而且畫面上不會有任何錯誤訊息，使用者只會覺得「快捷鍵怎麼忽然不能用了」。
            #
            # 只攔截 RuntimeError（例如視窗關閉時 self.root 已被銷毀）不夠周全，
            # 任何其他型別的例外（例如某個元件狀態不如預期）都可能讓監聽提前終止。
            # 這裡選擇「寧可吞掉這次按鍵、保住監聽執行緒繼續運作」，
            # 也不要讓一次例外拖垮之後所有的快捷鍵功能。
            pass

    def _on_close(self):
        """
        使用者關閉視窗時呼叫。
        必須先停止 pynput 的鍵盤監聽（移除系統鉤子），
        否則背景執行緒會一直存在，導致程式無法正常結束。
        """
        self.stop_requested = True   # 保險起見，順便通知播放迴圈中止

        if hasattr(self, "hotkey_listener"):
            self.hotkey_listener.stop()  # 停止 pynput 監聽、移除鍵盤鉤子

        self.root.destroy()  # 關閉 Tkinter 視窗，結束 mainloop()

    # ==================================================================
    # 小工具
    # ==================================================================
    def _set_status(self, text):
        """
        統一更新畫面底部的狀態文字。
        """
        self.label_status.config(text=f"狀態：{text}")


# ======================================================================
# 程式進入點
# ======================================================================
if __name__ == "__main__":
    root = tk.Tk()                 # 建立 Tkinter 主視窗物件
    app = MouseCoordinateLab(root) # 建立我們的應用程式實例，把主視窗傳進去
    root.mainloop()                # 進入 Tkinter 的事件迴圈，開始監聽使用者操作（按鈕點擊等）
                                    # 這行會一直阻塞，直到使用者關閉視窗為止