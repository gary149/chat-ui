export function parseTreatyError(error: unknown, fallback = "Request failed") {
	if (!error) return fallback;

	// Handle Treaty error object shape `{ status, value }`
	if (typeof error === "object") {
		const maybeRecord = error as Record<string, unknown>;
		if ("value" in maybeRecord) {
			const value = maybeRecord.value;
			if (typeof value === "string" && value.trim()) {
				return value;
			}
			if (value && typeof value === "object") {
				const record = value as Record<string, unknown>;
				if (typeof record.message === "string" && record.message.trim()) {
					return record.message;
				}
			}
		}
	}

	if (error instanceof Error) {
		try {
			const parsed = JSON.parse(error.message);
			if (parsed && typeof parsed === "object") {
				const record = parsed as Record<string, unknown>;
				if (record.value) {
					const value = record.value as Record<string, unknown> | string;
					if (typeof value === "string" && value.trim()) {
						return value;
					}
					if (value && typeof value === "object") {
						const message = (value as Record<string, unknown>).message;
						if (typeof message === "string" && message.trim()) {
							return message;
						}
					}
				}
				if (typeof record.message === "string" && record.message.trim()) {
					return record.message;
				}
			}
		} catch {
			// ignore json parse errors
		}

		if (error.message?.trim()) {
			return error.message;
		}
	}

	if (typeof error === "string" && error.trim()) {
		return error;
	}

	return fallback;
}
