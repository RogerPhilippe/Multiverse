const grid = document.getElementById('grid');

window.picker.services().then((services) => {
  for (const service of services) {
    const button = document.createElement('button');
    button.className = 'service';

    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = service.mark;
    mark.style.background = service.color;
    if (service.mark.length > 1) mark.classList.add('long');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = service.name;

    button.append(mark, name);
    button.addEventListener('click', () => window.picker.pick(service.id));
    grid.append(button);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.picker.cancel();
});
