// Phone layouts of the Race and Muscle dashes don't have room for a row of
// buttons, so the controls fold into a MENU button that opens a list of
// large, easy-to-tap buttons. On iPad the button is hidden by CSS and the
// controls stay in their row.

export function makeControlMenu(head, ctrls, buttonClass) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = buttonClass;
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  label.textContent = 'MENU';
  btn.append(label);

  const setOpen = (open) => {
    ctrls.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!ctrls.classList.contains('open'));
  });
  // Tap anywhere else to close.
  const outside = (e) => {
    if (ctrls.classList.contains('open') && !ctrls.contains(e.target) && !btn.contains(e.target)) setOpen(false);
  };
  document.addEventListener('pointerdown', outside);
  head.append(btn);

  return {
    btn,
    close: () => setOpen(false),
    destroy: () => {
      document.removeEventListener('pointerdown', outside);
      btn.remove();
    },
  };
}
