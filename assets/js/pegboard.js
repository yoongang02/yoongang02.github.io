(() => {
  const layouts = {
    1: [[50, 50]],
    2: [[28, 48], [72, 48]],
    3: [[18, 43], [50, 57], [82, 40]],
    4: [[20, 36], [42, 62], [64, 34], [84, 61]],
    5: [[15, 35], [34, 63], [52, 34], [69, 62], [86, 37]],
    6: [[13, 35], [29, 65], [45, 32], [59, 66], [74, 34], [88, 62]],
    7: [[12, 34], [26, 66], [39, 35], [52, 64], [65, 33], [78, 66], [89, 38]],
    8: [[11, 33], [23, 66], [35, 34], [47, 65], [59, 33], [71, 66], [83, 34], [91, 62]]
  };

  const generatedLayout = (count) => {
    const columns = Math.ceil(count / 2);
    const points = [];

    for (let index = 0; index < count; index += 1) {
      const row = index % 2;
      const column = Math.floor(index / 2);
      const x = 10 + (column * 80) / Math.max(columns - 1, 1);
      const y = row === 0 ? 34 + (column % 2) * 5 : 66 - (column % 2) * 5;
      points.push([x, y]);
    }

    return points;
  };

  document.querySelectorAll("[data-pegboard]").forEach((board) => {
    const magnets = [...board.querySelectorAll("[data-pegboard-magnet]")];
    const positions = layouts[magnets.length] || generatedLayout(magnets.length);
    let activeMagnet = null;

    magnets.forEach((magnet, index) => {
      const fallback = positions[index];
      const x = Number(magnet.dataset.x || fallback[0]);
      const y = Number(magnet.dataset.y || fallback[1]);

      magnet.style.setProperty("--magnet-x", x);
      magnet.style.setProperty("--magnet-y", y);
      magnet.classList.toggle("tooltip-right", x < 24);
      magnet.classList.toggle("tooltip-left", x > 76);
      magnet.classList.toggle("tooltip-below", y < 47);

      magnet.addEventListener("click", (event) => {
        if (!window.matchMedia("(hover: none), (pointer: coarse)").matches) {
          return;
        }

        if (activeMagnet !== magnet) {
          event.preventDefault();
          activeMagnet?.classList.remove("is-active");
          activeMagnet = magnet;
          magnet.classList.add("is-active");
        }
      });

      magnet.addEventListener("blur", () => {
        if (activeMagnet === magnet) {
          magnet.classList.remove("is-active");
          activeMagnet = null;
        }
      });
    });

    document.addEventListener("pointerdown", (event) => {
      if (activeMagnet && !activeMagnet.contains(event.target)) {
        activeMagnet.classList.remove("is-active");
        activeMagnet = null;
      }
    });
  });
})();
