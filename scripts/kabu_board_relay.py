"""
kabu STATION® API 板情報中継スクリプト
=====================================

【動作環境】
- Windows PC（kabuステーション®が起動していること）
- Python 3.8以上
- 必要ライブラリ: pip install requests websocket-client

【使い方】
1. kabuステーション®を起動する
2. このスクリプトをWindowsのコマンドプロンプトで実行:
   python kabu_board_relay.py

【動作の流れ】
kabuステーション® (localhost:18080)
    ↓ WebSocket で板情報をリアルタイム受信
このスクリプト（Windows）
    ↓ HTTP POST でクラウドWebアプリに転送
クラウドWebアプリ（stockalert-mwf5hf9f.manus.space）
    ↓ 板情報をキャッシュ・シグナル計算
ブラウザ画面に表示
"""

import json
import time
import threading
import requests
import websocket
import logging
from datetime import datetime

# ===== 設定 =====

# kabuステーション® APIの設定
# 検証環境: 18081、本番環境: 18080
KABU_API_PORT = 18081  # 検証環境
KABU_API_BASE = f"http://localhost:{KABU_API_PORT}/kabusapi"

# kabu STATION APIパスワード（kabuステーションのAPIシステム設定で設定したもの）
KABU_API_PASSWORD = "YOUR_API_PASSWORD_HERE"  # ← ここに設定したパスワードを入力

# 監視する銘柄コード（証券コード）
# 現在のシステムで使用している銘柄
WATCH_SYMBOLS = [
    {"Symbol": "6976", "Exchange": 1},  # 太陽誘電（東証プライム）
    {"Symbol": "6981", "Exchange": 1},  # 村田製作所（東証プライム）
    {"Symbol": "3778", "Exchange": 1},  # さくらインターネット（東証プライム）
    {"Symbol": "3436", "Exchange": 1},  # SUMCO（東証プライム）
    {"Symbol": "6600", "Exchange": 1},  # キオクシアHD（東証プライム）
]

# クラウドWebアプリのURL
CLOUD_API_URL = "https://stockalert-mwf5hf9f.manus.space/api/trpc/trading.pushOrderBook"

# 板情報の送信間隔（秒）- 同じ銘柄を連続送信しないためのレート制限
SEND_INTERVAL_SEC = 0.5

# ===== ログ設定 =====
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("kabu_relay.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)

# ===== グローバル変数 =====
api_token = None
last_send_time = {}  # 銘柄ごとの最終送信時刻


def get_api_token() -> str | None:
    """APIトークンを取得する"""
    try:
        response = requests.post(
            f"{KABU_API_BASE}/token",
            json={"APIPassword": KABU_API_PASSWORD},
            timeout=10,
        )
        if response.status_code == 200:
            token = response.json().get("Token")
            logger.info(f"APIトークン取得成功: {token[:8]}...")
            return token
        else:
            logger.error(f"APIトークン取得失敗: {response.status_code} {response.text}")
            return None
    except Exception as e:
        logger.error(f"APIトークン取得エラー: {e}")
        return None


def register_push_symbols(token: str) -> bool:
    """板情報のプッシュ配信を登録する"""
    try:
        response = requests.put(
            f"{KABU_API_BASE}/board",
            headers={"X-API-KEY": token},
            json={"Symbols": WATCH_SYMBOLS},
            timeout=10,
        )
        if response.status_code == 200:
            logger.info(f"{len(WATCH_SYMBOLS)}銘柄の板情報プッシュ配信を登録しました")
            return True
        else:
            logger.error(f"プッシュ配信登録失敗: {response.status_code} {response.text}")
            return False
    except Exception as e:
        logger.error(f"プッシュ配信登録エラー: {e}")
        return False


def parse_board_data(raw: dict) -> dict | None:
    """kabu STATION APIの板データをWebアプリ用に変換する"""
    try:
        symbol = str(raw.get("Symbol", ""))
        if not symbol:
            return None

        # 売気配（Sell1〜Sell10）を変換
        asks = []
        for i in range(1, 11):
            sell = raw.get(f"Sell{i}", {})
            if isinstance(sell, dict):
                price = sell.get("Price", 0)
                qty = sell.get("Qty", 0)
            else:
                price = raw.get(f"Sell{i}Price", 0)
                qty = raw.get(f"Sell{i}Qty", 0)
            if price and price > 0:
                asks.append({"price": float(price), "qty": int(qty)})

        # 買気配（Buy1〜Buy10）を変換
        bids = []
        for i in range(1, 11):
            buy = raw.get(f"Buy{i}", {})
            if isinstance(buy, dict):
                price = buy.get("Price", 0)
                qty = buy.get("Qty", 0)
            else:
                price = raw.get(f"Buy{i}Price", 0)
                qty = raw.get(f"Buy{i}Qty", 0)
            if price and price > 0:
                bids.append({"price": float(price), "qty": int(qty)})

        return {
            "symbol": symbol,
            "symbolName": str(raw.get("SymbolName", symbol)),
            "currentPrice": float(raw.get("CurrentPrice", 0)),
            "currentPriceTime": str(raw.get("CurrentPriceTime", "")),
            "asks": asks,
            "bids": bids,
            "marketOrderSellQty": int(raw.get("MarketOrderSellQty", 0)),
            "marketOrderBuyQty": int(raw.get("MarketOrderBuyQty", 0)),
            "overSellQty": int(raw.get("OverSellQty", 0)),
            "underBuyQty": int(raw.get("UnderBuyQty", 0)),
            "vwap": float(raw.get("VWAP", 0)),
        }
    except Exception as e:
        logger.error(f"板データ変換エラー: {e}")
        return None


def send_to_cloud(board_data: dict) -> bool:
    """板情報をクラウドWebアプリに送信する"""
    symbol = board_data.get("symbol", "")

    # レート制限チェック
    now = time.time()
    if symbol in last_send_time:
        elapsed = now - last_send_time[symbol]
        if elapsed < SEND_INTERVAL_SEC:
            return True  # スキップ（エラーではない）

    try:
        # tRPC形式でPOST送信
        response = requests.post(
            CLOUD_API_URL,
            json={"json": board_data},
            headers={"Content-Type": "application/json"},
            timeout=5,
        )
        if response.status_code == 200:
            last_send_time[symbol] = now
            logger.debug(f"送信成功: {symbol} 現値={board_data.get('currentPrice')}")
            return True
        else:
            logger.warning(f"送信失敗: {symbol} {response.status_code}")
            return False
    except Exception as e:
        logger.error(f"送信エラー: {symbol} {e}")
        return False


def on_message(ws, message):
    """WebSocketからメッセージを受信したとき"""
    try:
        raw = json.loads(message)
        board_data = parse_board_data(raw)
        if board_data:
            # 別スレッドで非同期送信（WebSocketをブロックしない）
            threading.Thread(
                target=send_to_cloud,
                args=(board_data,),
                daemon=True,
            ).start()
    except json.JSONDecodeError:
        pass  # 非JSONメッセージは無視


def on_error(ws, error):
    """WebSocketエラー"""
    logger.error(f"WebSocketエラー: {error}")


def on_close(ws, close_status_code, close_msg):
    """WebSocket切断"""
    logger.warning(f"WebSocket切断: {close_status_code} {close_msg}")


def on_open(ws):
    """WebSocket接続確立"""
    logger.info("WebSocket接続確立 - 板情報の受信を開始します")


def start_websocket(token: str):
    """WebSocketで板情報をリアルタイム受信する"""
    ws_url = f"ws://localhost:{KABU_API_PORT}/kabusapi/websocket"

    ws = websocket.WebSocketApp(
        ws_url,
        header={"X-API-KEY": token},
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )

    logger.info(f"WebSocket接続中: {ws_url}")
    ws.run_forever(ping_interval=30, ping_timeout=10)


def main():
    """メイン処理"""
    logger.info("=" * 50)
    logger.info("kabu STATION® API 板情報中継スクリプト 起動")
    logger.info(f"監視銘柄: {[s['Symbol'] for s in WATCH_SYMBOLS]}")
    logger.info(f"送信先: {CLOUD_API_URL}")
    logger.info("=" * 50)

    while True:
        # Step 1: APIトークンを取得
        logger.info("APIトークンを取得中...")
        token = get_api_token()
        if not token:
            logger.error("トークン取得失敗。30秒後に再試行します...")
            time.sleep(30)
            continue

        # Step 2: プッシュ配信を登録
        if not register_push_symbols(token):
            logger.error("プッシュ配信登録失敗。30秒後に再試行します...")
            time.sleep(30)
            continue

        # Step 3: WebSocketで板情報を受信（切断されるまでブロック）
        logger.info("板情報の受信を開始します...")
        start_websocket(token)

        # WebSocketが切断された場合、10秒後に再接続
        logger.warning("WebSocket切断。10秒後に再接続します...")
        time.sleep(10)


if __name__ == "__main__":
    main()
