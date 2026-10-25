- Fix News Events markers sliding off their place when zooming over Google 3D
  tiles: they were clamped to the coarse tiles loaded at the moment, which sank
  them 5 to 150 km under the surface and changed their depth with every zoom.
  They now sit at a fixed ground height (roolio, #11).
