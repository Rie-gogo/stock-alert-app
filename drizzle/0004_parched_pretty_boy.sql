CREATE TABLE `rt_candles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`tradeDate` varchar(10) NOT NULL,
	`candleTime` varchar(5) NOT NULL,
	`open` decimal(12,2) NOT NULL,
	`high` decimal(12,2) NOT NULL,
	`low` decimal(12,2) NOT NULL,
	`close` decimal(12,2) NOT NULL,
	`volume` bigint NOT NULL DEFAULT 0,
	`boardSnapshot` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_candles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rt_daily_summaries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tradeDate` varchar(10) NOT NULL,
	`initialCapital` bigint NOT NULL,
	`totalPnl` bigint NOT NULL DEFAULT 0,
	`tradesCount` int NOT NULL DEFAULT 0,
	`winCount` int NOT NULL DEFAULT 0,
	`lossCount` int NOT NULL DEFAULT 0,
	`candlesReceived` int NOT NULL DEFAULT 0,
	`reportSent` boolean NOT NULL DEFAULT false,
	`reportSentAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rt_daily_summaries_id` PRIMARY KEY(`id`),
	CONSTRAINT `rt_daily_summaries_tradeDate_unique` UNIQUE(`tradeDate`)
);
--> statement-breakpoint
CREATE TABLE `rt_trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tradeDate` varchar(10) NOT NULL,
	`symbol` varchar(10) NOT NULL,
	`symbolName` varchar(50) NOT NULL,
	`action` enum('buy','sell','short','cover') NOT NULL,
	`price` decimal(12,2) NOT NULL,
	`shares` int NOT NULL,
	`amount` bigint NOT NULL,
	`pnl` bigint,
	`reason` text NOT NULL,
	`tradeTime` varchar(5) NOT NULL,
	`side` enum('long','short') NOT NULL,
	`boardSignal` varchar(30),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rt_trades_id` PRIMARY KEY(`id`)
);
