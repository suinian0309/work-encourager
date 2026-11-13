<script setup lang="ts">
withDefaults(
  defineProps<{
    name:
      | 'settings'
      | 'minimize'
      | 'close'
      | 'gift'
      | 'clock'
      | 'history'
      | 'back'
      | 'plus'
      | 'trash'
      | 'up'
      | 'down'
      | 'folder'
      | 'coin'
      | 'spark'
      | 'moon'
      | 'sun'
      | 'pin'
      | 'float'
      | 'expand'
    size?: number
  }>(),
  { size: 16 }
)
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'settings'">
      <circle cx="12" cy="12" r="3.2" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.54 1.7 1.7 0 0 0 10 3V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.46 9c.12.37.42.7.8.88.22.1.46.16.7.16H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z"
      />
    </template>
    <template v-else-if="name === 'minimize'">
      <path d="M5 12h14" />
    </template>
    <template v-else-if="name === 'close'">
      <path d="M6 6l12 12M18 6L6 18" />
    </template>
    <template v-else-if="name === 'gift'">
      <rect x="3.5" y="8" width="17" height="4" rx="1" />
      <path d="M5 12v8.5h14V12M12 8v12.5" />
      <path d="M12 8S10.5 3.5 8.2 4.4C6.2 5.2 7.4 8 9.6 8H12Zm0 0s1.5-4.5 3.8-3.6C17.8 5.2 16.6 8 14.4 8H12Z" />
    </template>
    <template v-else-if="name === 'clock'">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </template>
    <template v-else-if="name === 'history'">
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3.5 4.5V9H8" />
      <path d="M12 8v4.2l3 1.8" />
    </template>
    <template v-else-if="name === 'back'">
      <path d="M15 5l-7 7 7 7" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M4 7h16M9.5 7V4.8h5V7M6.5 7l.9 12h9.2l.9-12M10 11v4M14 11v4" />
    </template>
    <template v-else-if="name === 'up'">
      <path d="M6 14l6-6 6 6" />
    </template>
    <template v-else-if="name === 'down'">
      <path d="M6 10l6 6 6-6" />
    </template>
    <template v-else-if="name === 'folder'">
      <path d="M3.5 6.5h6l1.8 2h9.2v9.5h-17z" />
      <path d="M3.5 8.5v-2" />
    </template>
    <template v-else-if="name === 'coin'">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 8.5l3 3 3-3M12 11.5V16M9.5 13.5h5" />
    </template>
    <template v-else-if="name === 'spark'">
      <path d="M12 3.5l1.6 4.9 4.9 1.6-4.9 1.6L12 16.5l-1.6-4.9L5.5 10l4.9-1.6z" />
      <path d="M18.5 16.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7z" />
    </template>
    <template v-else-if="name === 'moon'">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </template>
    <template v-else-if="name === 'sun'">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
    </template>
    <template v-else-if="name === 'pin'">
      <path d="M9 4h6l-1 5 3 3H7l3-3-1-5Z" />
      <path d="M12 12v8" />
    </template>
    <template v-else-if="name === 'float'">
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <rect x="11.5" y="11" width="7" height="6" rx="1.5" />
      <path d="M6 9h5" />
    </template>
    <template v-else-if="name === 'expand'">
      <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
    </template>
  </svg>
</template>
