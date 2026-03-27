import { CronExpressionParser } from "cron-parser";

export function getNextCronOccurrence(
	expression: string,
	after: Date,
	timezone?: string | null,
): Date {
	const interval = CronExpressionParser.parse(expression, {
		currentDate: after,
		...(timezone ? { tz: timezone } : {}),
	});

	return interval.next().toDate();
}
