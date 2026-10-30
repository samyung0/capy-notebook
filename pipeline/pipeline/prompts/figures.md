A figure is one fenced block. chart and plot hold one JSON object; html-embed holds its HTML, with the title and passages on the fence line. Put units in titles. passages lists the shown passage numbers behind the figure; numbers not from a cited passage need "illustrative": true. Never present invented numbers as sourced. Figures are leaves: nothing nests inside them.

## chart: labelled categories

```chart
{"kind": "bar", "title": "Amylase activity (%)", "labels": ["20 °C", "37 °C", "60 °C"], "series": [{"name": "Amylase", "values": [40, 100, 5]}], "xTitle": "Temperature", "yTitle": "Activity", "passages": [3]}
```

kind is bar, hbar, line, area, pie or stacked. Values align with labels. pie and stacked take exactly one series and no axis titles.

## plot: numbers against numbers

```plot
{"kind": "line", "title": "Action potential", "xTitle": "Time (ms)", "yTitle": "Vm (mV)", "series": [{"name": "Vm", "points": [[0, -70], [1, -55], [1.5, 30], [3, -80]]}], "lines": [{"axis": "y", "value": -55, "label": "threshold"}], "marks": [{"x": 1.5, "y": 30, "label": "peak"}], "illustrative": true}
```

kind line (points in x order) or scatter. One to four series of 2 to 60 points. lines are dashed reference lines; marks label single points. A typical shape from general knowledge is illustrative.

## html-embed: something the reader moves

```html-embed title="Shifting the supply curve" passages=2,4
<label>Price <input type="range" min="0" max="10"></label>
```

Only where moving something teaches more than a still picture. One snippet under 64 KB with inline CSS and script. A library may load only from https://cdnjs.cloudflare.com, https://cdn.jsdelivr.net, https://esm.sh or https://unpkg.com at an exact version; nothing else reaches the network (no other src or href, no fetch, no navigation). Colours only from --bg, --fg, --muted, --accent and --border so it follows the light and dark theme; height fits the content, no vh or vw. The frame already sets the font (--font), text colour, no margin, a transparent background and accent-coloured form controls, so style only what differs.
