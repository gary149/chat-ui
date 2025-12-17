# MCP Endpoint Performance Report

**Endpoint:** `https://mcp.exa.ai/mcp`
**Date:** 2025-12-17
**Report Type:** Connection Time Performance Analysis

---

## Executive Summary

This report documents the performance characteristics of the Exa AI MCP (Model Context Protocol) endpoint at `https://mcp.exa.ai/mcp`. Due to network egress restrictions in the testing environment, direct connection testing was not possible. However, this report combines attempted test results with publicly documented performance metrics from Exa AI.

---

## Test Environment

- **Platform:** Linux 4.4.0
- **Testing Method:** curl with timing metrics
- **Number of Planned Tests:** 10

### Network Restrictions Encountered

The testing environment uses a proxy with an allowlist of approved domains. The `mcp.exa.ai` domain is **not included** in the allowed hosts list, resulting in:

```
curl: (56) CONNECT tunnel failed, response 403
```

This is a proxy-level block, not an issue with the Exa MCP endpoint itself.

---

## Attempted Connection Metrics

| Metric | Result |
|--------|--------|
| DNS Lookup | N/A (blocked by proxy) |
| TCP Connect Time | 0.000461s (to proxy) |
| SSL Handshake | N/A (blocked before SSL) |
| Time to First Byte | N/A |
| Total Time | 0.003658s (until rejection) |
| HTTP Status | 403 (proxy rejection) |

---

## Exa MCP Documented Performance Characteristics

Based on official Exa AI documentation and public sources:

### Latency Tiers

| Tier | Latency | Use Case |
|------|---------|----------|
| **Exa Fast** | < 500ms | Low-latency search, most common |
| **Exa Deep** | 2-5 seconds | Highest accuracy, agentic multi-search |
| **Standard** | ~1000ms | Balanced speed/quality |

### Key Performance Claims

1. **Sub-500ms Response Times**: Exa Fast is positioned as the most accurate search API under 500ms
2. **Independent Infrastructure**: Built from scratch (not wrapping Google), enabling faster performance
3. **High Rate Limits**: Designed for production scale
4. **High Reliability**: Enterprise-grade uptime

### MCP Server Options

| Option | Latency Impact | Notes |
|--------|----------------|-------|
| Hosted Remote (`mcp.exa.ai`) | Standard | Zero-setup, quick testing |
| Local Server | Lower | More control, private network support |
| VPC Deployment | Lowest | Enhanced security, optimal for production |

---

## Recommendations for Proper Testing

To accurately measure connection time performance for this MCP endpoint, testing should be conducted from an environment with:

1. **Direct Internet Access**: No proxy restrictions blocking `mcp.exa.ai`
2. **Geographic Proximity**: Test from multiple regions to measure latency variations
3. **Proper Authentication**: Include valid Exa API key in requests
4. **MCP Protocol Compliance**: Use proper MCP handshake rather than raw HTTP

### Suggested Test Script

```bash
#!/bin/bash
# Requires: Direct internet access, valid EXA_API_KEY

URL="https://mcp.exa.ai/mcp"
NUM_TESTS=20

for i in $(seq 1 $NUM_TESTS); do
    curl -w "%{time_namelookup},%{time_connect},%{time_appconnect},%{time_starttransfer},%{time_total}\n" \
        -s -o /dev/null \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $EXA_API_KEY" \
        "$URL"
    sleep 1
done
```

### Expected Metrics (Based on Documentation)

| Metric | Expected Range |
|--------|----------------|
| DNS Lookup | 1-50ms |
| TCP Connect | 10-100ms |
| SSL Handshake | 50-150ms |
| Time to First Byte | 100-500ms (Exa Fast) |
| Total Response Time | 200-600ms (typical) |

---

## Conclusion

The Exa MCP endpoint at `https://mcp.exa.ai/mcp` could not be directly tested due to network egress restrictions in the current environment. Based on Exa's documentation:

- **Expected connection time**: Sub-500ms for fast search
- **Architecture**: Independent infrastructure (not Google-wrapped)
- **Reliability**: High availability designed for production use

For accurate performance metrics, testing should be conducted from an unrestricted network environment with proper MCP protocol implementation.

---

## Sources

- [Exa MCP Documentation](https://docs.exa.ai/reference/exa-mcp)
- [Exa API 2.1 Blog Post](https://exa.ai/blog/exa-api-2-1)
- [Exa MCP Server GitHub](https://github.com/exa-labs/exa-mcp-server)
- [How to Install Exa MCP Server](https://apidog.com/blog/exa-mcp-server/)
