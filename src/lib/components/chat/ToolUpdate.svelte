<script lang="ts">
  import { MessageToolUpdateType, type MessageToolUpdate } from "$lib/types/MessageUpdate";
  import {
    isMessageToolCallUpdate,
    isMessageToolErrorUpdate,
    isMessageToolResultUpdate,
  } from "$lib/utils/messageUpdates";

  import CarbonTools from "~icons/carbon/tools";
  import { ToolResultStatus, type ToolFront } from "$lib/types/Tool";
  import { page } from "$app/state";
  import { onDestroy } from "svelte";
  import { browser } from "$app/environment";

  interface Props {
    tool: MessageToolUpdate[];
    loading?: boolean;
  }

  let { tool, loading = false }: Props = $props();

  const toolFnName = tool.find(isMessageToolCallUpdate)?.call.name;
  let toolError = $derived(tool.some(isMessageToolErrorUpdate));
  let toolDone = $derived(tool.some(isMessageToolResultUpdate));

  let eta = $derived(tool.find((el) => el.subtype === MessageToolUpdateType.ETA)?.eta);

  // Gracefully handle missing tools in page data
  const availableTools: ToolFront[] = (page.data as any)?.tools ?? [];

  let loadingBarEl: HTMLDivElement | undefined = $state();
  let animation: Animation | undefined = $state(undefined);

  let isShowingLoadingBar = $state(false);

  $effect(() => {
    !toolError &&
      !toolDone &&
      loading &&
      loadingBarEl &&
      eta &&
      (() => {
        loadingBarEl.classList.remove("hidden");
        isShowingLoadingBar = true;
        animation = loadingBarEl.animate([{ width: "0%" }, { width: "calc(100%+1rem)" }], {
          duration: eta * 1000,
          fill: "forwards",
        });
      })();
  });

  onDestroy(() => {
    if (animation) {
      animation.cancel();
    }
  });

  // go to 100% quickly if loading is done
  $effect(() => {
    (!loading || toolDone || toolError) &&
      browser &&
      loadingBarEl &&
      isShowingLoadingBar &&
      (() => {
        isShowingLoadingBar = false;

        loadingBarEl.classList.remove("hidden");

        animation?.cancel();
        animation = loadingBarEl.animate(
          [{ width: loadingBarEl.style.width }, { width: "calc(100%+1rem)" }],
          {
            duration: 300,
            fill: "forwards",
          }
        );

        setTimeout(() => {
          loadingBarEl?.classList.add("hidden");
        }, 300);
      })();
  });

  // Dedupe parameters: show only from the latest Call update with parsed parameters
  let latestParams = $derived(() => {
    const lastCall = [...tool].reverse().find(isMessageToolCallUpdate);
    const params = lastCall?.call?.parameters || {};
    return params && typeof params === "object" ? params : {};
  });

  // Aggregate results: concatenate all success outputs' content fields (if present)
  let aggregatedResult = $derived(() => {
    const parts: string[] = [];
    for (const tu of tool) {
      if (isMessageToolResultUpdate(tu) && tu.result.status === ToolResultStatus.Success) {
        for (const o of tu.result.outputs ?? []) {
          const v = (o as any)?.content ?? JSON.stringify(o);
          if (typeof v === "string") parts.push(v);
        }
      }
    }
    return parts.join("");
  });

  // Last error message (if any)
  let lastError = $derived(() => {
    const err = [...tool].reverse().find(isMessageToolErrorUpdate);
    return err?.message ?? "";
  });
</script>

{#if toolFnName}
  <details
    class="group/tool my-2.5 w-fit cursor-pointer rounded-lg border border-gray-200 bg-white pl-1 pr-2.5 text-sm shadow-sm transition-all open:mb-3
        open:border-purple-500/10 open:bg-purple-600/5 open:shadow-sm dark:border-gray-800 dark:bg-gray-900 open:dark:border-purple-800/40 open:dark:bg-purple-800/10"
  >
    <summary
      class="relative flex select-none list-none items-center gap-1.5 py-1 group-open/tool:text-purple-700 group-open/tool:dark:text-purple-300"
    >
      <div
        bind:this={loadingBarEl}
        class="absolute -m-1 hidden h-full w-[calc(100%+1rem)] rounded-lg bg-purple-500/5 transition-all dark:bg-purple-500/10"
      ></div>

      <div
        class="relative grid size-[22px] place-items-center rounded bg-purple-600/10 dark:bg-purple-600/20"
      >
        <svg
          class="absolute inset-0 text-purple-500/40 transition-opacity"
          class:invisible={toolDone || toolError}
          width="22"
          height="22"
          viewBox="0 0 38 38"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            class="loading-path"
            d="M8 2.5H30C30 2.5 35.5 2.5 35.5 8V30C35.5 30 35.5 35.5 30 35.5H8C8 35.5 2.5 35.5 2.5 30V8C2.5 8 2.5 2.5 8 2.5Z"
            stroke="currentColor"
            stroke-width="1"
            stroke-linecap="round"
            id="shape"
          />
        </svg>
        <CarbonTools class="text-xs text-purple-700 dark:text-purple-500" />
      </div>

      <span>
        {toolError ? "Error calling" : toolDone ? "Called" : "Calling"} tool
        <span class="font-semibold"
          >{availableTools.find((tool) => tool.name === toolFnName)?.displayName ?? toolFnName}</span
        >
      </span>
    </summary>
    {#if Object.keys(latestParams).length}
      <div class="mt-1 flex items-center gap-2 opacity-80">
        <h3 class="text-sm">Parameters</h3>
        <div class="h-px flex-1 bg-gradient-to-r from-gray-500/20"></div>
      </div>
      <ul class="py-1 text-sm">
        {#each Object.entries(latestParams) as [k, v]}
          {#if v !== null}
            <li>
              <span class="font-semibold">{k}</span>:
              <span>{String(v)}</span>
            </li>
          {/if}
        {/each}
      </ul>
    {/if}

    {#if toolError}
      <div class="mt-1 flex items-center gap-2 opacity-80">
        <h3 class="text-sm">Error</h3>
        <div class="h-px flex-1 bg-gradient-to-r from-gray-500/20"></div>
      </div>
      <pre class="whitespace-pre-wrap rounded-md bg-red-50 p-2 text-red-800 dark:bg-red-950/40 dark:text-red-300">{lastError}</pre>
    {:else if aggregatedResult.trim().length}
      <div class="mt-1 flex items-center gap-2 opacity-80">
        <h3 class="text-sm">Result</h3>
        <div class="h-px flex-1 bg-gradient-to-r from-gray-500/20"></div>
      </div>
      <pre class="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-gray-50 p-2 text-gray-700 dark:bg-gray-800 dark:text-gray-200">{aggregatedResult}</pre>
    {/if}
  </details>
{/if}

<style>
  details summary::-webkit-details-marker {
    display: none;
  }

  .loading-path {
    stroke-dasharray: 61.45;
    animation: loading 2s linear infinite;
  }
</style>
