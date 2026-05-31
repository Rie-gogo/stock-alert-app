import React from 'react';
import { AlertLog } from '../types';
import { AlertTriangle, TrendingUp, TrendingDown, Zap, ShieldAlert, BellRing } from 'lucide-react';

interface AlertHistoryComponentProps {
  alerts: AlertLog[];
  onSelectAlert: (alert: AlertLog) => void;
}

export default function AlertHistoryComponent({ alerts, onSelectAlert }: AlertHistoryComponentProps) {
  // アラートの種類に応じたアイコンとカラーを取得
  const getAlertMeta = (type: AlertLog['type']) => {
    switch (type) {
      case 'ma_cross':
        return {
          icon: <Zap className="w-4 h-4 text-cyan-400" />,
          bg: 'bg-cyan-500/10 border-cyan-500/20',
          badge: 'bg-cyan-500/20 text-cyan-300',
          label: 'MAクロス',
        };
      case 'rsi':
        return {
          icon: <TrendingUp className="w-4 h-4 text-purple-400" />,
          bg: 'bg-purple-500/10 border-purple-500/20',
          badge: 'bg-purple-500/20 text-purple-300',
          label: 'RSI指標',
        };
      case 'bollinger':
        return {
          icon: <ShieldAlert className="w-4 h-4 text-blue-400" />,
          bg: 'bg-blue-500/10 border-blue-500/20',
          badge: 'bg-blue-500/20 text-blue-300',
          label: 'ボリンジャー',
        };
      case 'volume_sell_off':
        return {
          icon: <AlertTriangle className="w-4 h-4 text-yellow-500" />,
          bg: 'bg-yellow-500/10 border-yellow-500/20 animate-pulse',
          badge: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
          label: '超大口売り',
        };
      case 'volume_buy_up':
        return {
          icon: <BellRing className="w-4 h-4 text-pink-500" />,
          bg: 'bg-pink-500/10 border-pink-500/20',
          badge: 'bg-pink-500/20 text-pink-400 border border-pink-500/30',
          label: '大口買い上がり',
        };
      default:
        return {
          icon: <BellRing className="w-4 h-4 text-muted-foreground" />,
          bg: 'bg-muted/10 border-muted/20',
          badge: 'bg-muted/20 text-muted-foreground',
          label: 'アラート',
        };
    }
  };

  return (
    <div className="flex flex-col h-full bg-background border border-border rounded-lg overflow-hidden">
      {/* ヘッダー */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30 select-none">
        <div className="flex items-center space-x-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive"></span>
          </span>
          <h3 className="text-xs font-bold text-foreground">リアルタイム・アラート履歴ログ</h3>
        </div>
        <span className="text-[10px] text-muted-foreground font-mono">
          ログ件数: {alerts.length} 件
        </span>
      </div>

      {/* アラートログテーブル */}
      <div className="flex-1 overflow-y-auto max-h-[220px]">
        {alerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <BellRing className="w-8 h-8 mb-2 text-muted/40 stroke-[1.5]" />
            <p className="text-xs">売買シグナルまたは大口取引アラートはまだ発生していません</p>
            <p className="text-[10px] text-muted/60 mt-1">リアルタイムデータからシグナルを常時監視中...</p>
          </div>
        ) : (
          <table className="w-full text-left border-collapse text-xs font-mono">
            <thead>
              <tr className="bg-muted/20 border-b border-border text-[10px] text-muted-foreground select-none sticky top-0 z-10">
                <th className="py-1.5 px-3">時刻</th>
                <th className="py-1.5 px-3">銘柄</th>
                <th className="py-1.5 px-3">アラート種類</th>
                <th className="py-1.5 px-3 text-center">シグナル</th>
                <th className="py-1.5 px-3">約定価格</th>
                <th className="py-1.5 px-3">詳細内容</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {alerts.map((log) => {
                const meta = getAlertMeta(log.type);
                
                return (
                  <tr
                    key={log.id}
                    onClick={() => onSelectAlert(log)}
                    className={`cursor-pointer hover:bg-muted/30 transition-colors duration-150 group`}
                  >
                    {/* 時刻 */}
                    <td className="py-2 px-3 text-muted-foreground text-[11px]">
                      {log.time}
                    </td>

                    {/* 銘柄コード */}
                    <td className="py-2 px-3 font-bold text-foreground group-hover:text-primary transition-colors">
                      {log.symbol}
                    </td>

                    {/* アラート種別 */}
                    <td className="py-2 px-3">
                      <div className="flex items-center space-x-1.5">
                        {meta.icon}
                        <span className={`text-[10px] px-1.5 py-0.2 rounded font-sans ${meta.badge}`}>
                          {meta.label}
                        </span>
                      </div>
                    </td>

                    {/* シグナル区分 */}
                    <td className="py-2 px-3 text-center">
                      {log.signal === 'B' ? (
                        <span className="bg-destructive/20 text-destructive border border-destructive/30 px-2 py-0.2 rounded font-extrabold text-[10px]">
                          BUY
                        </span>
                      ) : log.signal === 'S' ? (
                        <span className="bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.2 rounded font-extrabold text-[10px]">
                          SELL
                        </span>
                      ) : (
                        <span className="bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 px-2 py-0.2 rounded font-extrabold text-[10px]">
                          WARN
                        </span>
                      )}
                    </td>

                    {/* 価格 */}
                    <td className="py-2 px-3 font-bold text-foreground">
                      {log.price.toFixed(1)}
                    </td>

                    {/* メッセージ */}
                    <td className="py-2 px-3 text-muted-foreground text-[11px] max-w-md truncate">
                      {log.message}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
