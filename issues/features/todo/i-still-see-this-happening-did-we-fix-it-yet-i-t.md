id: abb0c4
branch: mc/i-still-see-this-happening-did-we-fix-it-yet-i-t-abb0c4
acceptance: script:build

Auto-created from run.

I still see this happening, did we fix it yet? I think that code is running on the newest version, if not, one back:

→ request run reference:read
      action: run
      name: reference:read
      args: query=minecraft-java/26.3/content/api/gui/net.minecraft.client.gui.components.md#package-net-minecraft-client-gui-components
    ← response
      {"content":[{"type":"text","text":"bad arguments for reference:read: unknown query. Schema: {\"path\":{\"type\":\"string\",\"required\":true,\"description\":\"Stor
