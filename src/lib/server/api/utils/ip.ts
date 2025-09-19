export const getRequestIp = (request: Request): string => {
	const forwarded = request.headers.get("x-forwarded-for");
	if (forwarded) {
		return forwarded.split(",")[0]!.trim();
	}
	const realIp =
		request.headers.get("cf-connecting-ip") ??
		request.headers.get("x-real-ip") ??
		request.headers.get("forwarded");
	if (realIp) {
		const match = realIp.match(/for=([^;]+)/i);
		if (match?.[1]) {
			return match[1].replace(/"/g, "").trim();
		}
		return realIp.split(",")[0]!.trim();
	}
	return "0.0.0.0";
};
