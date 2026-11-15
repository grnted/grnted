# Third-party libraries used by test fixtures only

Unmodified copies, as published on npm, for tests that need the real library (what listeners it adds to
its chart by default). They are never part of the built package or of anything Granted serves.

- `chartjs/chart.umd.js`: Chart.js 4.4.7 (`chart.js@4.4.7`, `dist/chart.umd.js`), (c) Chart.js Contributors,
  MIT License (`chartjs/LICENSE.md`). https://www.chartjs.org
- `echarts/echarts.simple.min.js`: Apache ECharts 5.5.1 (`echarts@5.5.1`, `dist/echarts.simple.min.js`),
  Copyright The Apache Software Foundation, Apache License 2.0 (`echarts/LICENSE`, `echarts/NOTICE`).
  https://echarts.apache.org

Highcharts and Google Charts may not be redistributed, so the fixtures that stand for them are written
by hand: they put the same listeners on the same elements as the library's default chart does (measured
on Highcharts 11.4.8 and on Google Charts `corechart`), and draw a plain chart of their own.
