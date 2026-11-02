import actions from '../other/actions.js';
import autoassist from 'https://esm.run/@camilaprav/kittygpt@0.0.65/autoassist.js';
import morphdom from 'https://esm.run/morphdom';
import { arrayify, debounce, resolve } from '../other/util.js';
import { loadman } from '../other/util.js';

export default class Assistant {
  actions = {
    init: async () => {
      let { bus } = state.event;
      this.state.doc = new DOMParser().parseFromString('<!doctype html><head></head><body><div></div></body>', 'text/html');
      for (let x of ['designer:htmlsnap:ready', 'designer:select:ready', 'files:select:ready']) {
        bus.on(x, ({ frame, path }) => {
          frame ??= state.designer.list.find(x => x.path === path);
          if (!frame?.ready) return;
          this.state.doc.head.innerHTML = frame.head.innerHTML;
          this.state.doc.body.firstElementChild.outerHTML = frame.body.firstElementChild.outerHTML;
        });
      }
      bus.on('projects:create:ready', async () => {
        if (!this.state.tutorial || this.state.tutorial.includes('bravo')) return;
        await this.state.session.prompt('cue bravo');
      });
      bus.on('files:select:ready', async ({ path }) => {
        if (!this.state.tutorial || this.state.tutorial.includes('charlie') || !path) return;
        if (path !== 'pages/index.html') {
          await this.state.session.prompt(`cue joker: selected some other file or dir`);
          return;
        }
        this.state.tutorial.push('charlie');
        await this.state.session.prompt('cue charlie');
      });
      bus.on('actions:changeSelection:ready', async ({ s }) => {
        if (!this.state.tutorial || this.state.tutorial.includes('delta')) return;
        let els = s?.map?.(x => state.designer.current.map.get(x)) || [];
        let html = els.map(el => [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent.trim()).filter(Boolean).join(' ')).join('\n');
        if (!html.includes('intentionally left blank')) {
          await this.state.session.prompt(`cue joker: selected some other element`);
          return;
        }
        this.state.tutorial.push('delta');
        await this.state.session.prompt('cue delta');
      });
    },

    start: async (tutorial = false) => {
      try {
        this.state.tutorial = tutorial && [];
        this.state.initializing = true;
        d.update();
        let prefix = location.pathname.includes('/files/') ? '../' : '';
        let mss = d.el('script', { src: prefix + 'other/mespeak/mespeak.js' });
        document.head.append(mss);
        await new Promise((pres, prej) => { mss.onerror = prej; mss.onload = pres });
        await new Promise((pres, prej) => meSpeak.loadVoice('voices/en/en-us.json', success => success ? pres() : prej(new Error(`Could not load meSpeak voice`))));
        this.state.session = await autoassist({
          endpoint: 'https://kittygpt.netlify.app/.netlify/functions/voicechat',
          model: 'gpt-realtime-2025-08-28',
          navdisable: true,
          idtrack: true,
          removeInvisible: false,
          scope: this.state.doc.documentElement,
          pushToSpeak: state.settings.opt.shiftToSpeak && 'Shift',
        });
        let fns = Object.fromEntries([...Object.entries(actions)].filter(([k, v]) => !v.codexOnly).map(([k, v]) => [k, {
          description: v.description,
          parameters: v.parameters,
          handler: async params => {
            try {
              if (document.querySelector('dialog')) throw new Error(`Operation not possible: A modal dialog is currently open`);
              let disabled = v?.disabled?.(params)?.filter?.(Boolean);
              if (disabled?.length) return { success: false, error: `Operation not possible because:\n${disabled.map(x => `- ${x}`).join('\n')}` };
              return await v.handler(params);
            } catch (err) {
              console.error(err);
              return { success: false, error: err.toString() };
            }
          },
        }]));
        this.state.session.sysupdate({
          lang: navigator.language || navigator.userLanguage || 'en-US',
          main: `You're Webfoundry Assistant, a voice assistant embedded into a web app and site creation tool.`,
          disabledFns: `Whenever a disabled function is requested, tell the user the reasons.`,
          selections: `MISSION CRITICAL: All operations happen relative to the selected elements, so make sure to select the right ones before issuing any commands.`,
          precision: `When requested to select an element, make sure it's the right target by checking its HTML. If confused, ask for clarifications.`,
          imageContent: `When asked to select or manipulate a specific image by visual content, remind the user you have no access to image contents, ask for other instructions such as CSS classes, attributes, or image URL.`,
          imageGeneration: `When asked to generate images, make sure to probe the user to understand exactly the style as well as what they want before generating.`,
          codeEditor: `The code editor can change quickly (both contents and visible portion due to scrolling). Call the appropriate functions before answering every single user query for up-to-date context.`,
          iconsSidebar: `To the left there's a sidebar with icons for Projects (4 boxes icon), Files (folder icon; only visible when a project is open), Styles (pencil icon; only visible in visual editor mode), Play/Stop icons (enters or leaves page preview mode; only visible in page visual editor mode), Settings/Config (3 vertical dots); the cross icon temporarily closes the sidebar.`,
          projectsPanel: `Lists previously created projects. Blue Create button lets users create new ones, pencil and trash can icons next to project names let users rename or delete a project.`,
          filesPanel: `Lists project files and directories. Blue Create button lets users create new files and directories in the project root. The plus icon, pencil icon, and trash can icon next to specific files and directories lets users create files and subdirectories inside existing directories, rename or delete a file. Dragging and dropping also works for moving files between directories.`,
          mode: tutorial && `You're in tutorial mode. Don't do anything on behalf of the user unless instructions request it or he explicitly asks you to, and whenever you do explain how they could do the same themselves through the UI. Whenever you hear the words CUE-ALPHA/BRAVO/CHARLIE/etc, follow the instructions below. Don't ask the user to tell you when he's done, you'll hear the cues automatically.`,
          zeta: `When you hear the words CUE-ZETA, cueZeta will contain a Codex reasoning string, read it aloud.`,
          cueAlpha: tutorial && `Give the user a warm welcome and tell them you're about to teach them some Webfoundry kickstarter tips & tricks. First, tell them to create a new project and name it any way they want. Explain how to navigate the UI to do so.`,
          cueBravo: tutorial && `Now that the project is created, instruct the user to click the index.html file in the pages directory.`,
          cueCharlie: tutorial && `Explain they're looking at Webfoundry's visual editor now, which contains placeholder text that's safe to delete. For starters instruct them to select the "Page intentionally left blank" box.`,
          cueDelta: tutorial && `Tell the user the blue box around the selection tells them they've just selected the element successfully. Silently call the throw confetti function first and then ask them to find and click the cross icon in the toolbar on the top-right corner.`,
          cueJoker: tutorial && `Tell the user what he just did and how, invite him to explore different things a little if he wants but gently nudge him back on track for the tutorial, politely asking of suggesting him to fulfill your last instruction next if he drifts for too long.`,
        }, fns);
        this.state.session.prompt = debounce(this.state.session.prompt, 1000);
        tutorial && this.state.session.prompt('cue alpha');
      } catch (err) {
        this.state.tutorial = null;
        throw err;
      } finally {
        this.state.initializing = false;
      }
    },

    stop: () => { this.state.session.stop(); this.state.tutorial = null; this.state.session = null },
  };
};
