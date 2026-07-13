# Project Log — GitHub Pages template

A simple, dependency-free portfolio template: one homepage with an intro and
a grid of projects, and a detail page per project. Plain HTML/CSS/JS — no
build step, so it works as-is with GitHub Pages.

## Structure

```
index.html              ← homepage: nav, intro, project grid
projects/
  project-1.html        ← detail page for project 1
  project-2.html        ← detail page for project 2
  project-3.html        ← detail page for project 3
css/style.css           ← all styling (colors/fonts as CSS variables at the top)
js/nav.js               ← mobile menu toggle
assets/images/          ← put your thumbnails, hero shots, etc. here
assets/videos/          ← put your .mp4 clips here
```

## Customize the homepage

1. Open `index.html`.
2. Edit the text inside `<div class="title-block">` — that's your intro,
   plus a small metadata row (location, focus, contact, links).
3. For each project, duplicate one `<a class="project-card">` block inside
   `.project-grid`, and update:
   - the `href` (which `projects/*.html` page it links to)
   - the thumbnail — replace the `.thumb-placeholder` div with
     `<img src="assets/images/your-thumb.jpg" alt="...">`
   - the `Fig. 0X` label, title, description, and tags

## Add a new project page

1. Copy `projects/project-1.html` to `projects/project-4.html` (etc.).
2. Update the `<title>`, the `Fig. 0X` label, heading, and metadata row
   (role / tools / year / status).
3. Replace the image/video `src` paths with your own files in `assets/`.
4. Update the "prev / next" links at the bottom of the page.
5. Link to it from a new project card on `index.html`.

## Images and videos

- Thumbnails on the homepage look best around **800×600** (4:3) — they're
  cropped to fill their frame automatically.
- Drop files into `assets/images/` and `assets/videos/`, then reference them
  with a relative path like `../assets/images/my-photo.jpg` from inside
  `projects/*.html`, or `assets/images/my-photo.jpg` from `index.html`.
- For video, use an actual `<video controls>` tag (see the example already
  in `project-1.html`) rather than linking out to YouTube, unless you'd
  rather embed a YouTube iframe.

## Colors and fonts

Everything themeable lives at the top of `css/style.css` in the `:root`
block — six or so variables control the whole palette and both typefaces.
Change those and the whole site re-themes.

## Deploying to GitHub Pages

1. Push this folder to a repo named `yourusername.github.io` (for a
   user site) — or any repo name for a project site.
2. In the repo settings, go to **Pages** and set the source branch to
   `main` (root).
3. Your site will be live at `https://yourusername.github.io/` (or
   `https://yourusername.github.io/reponame/` for a project site — in that
   case double check the relative links still resolve, they should since
   everything here uses relative paths).
