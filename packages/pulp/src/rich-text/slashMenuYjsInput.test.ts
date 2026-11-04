import {expect,it} from "vitest";
import {EditorState,TextSelection} from "prosemirror-state";
import {EditorView} from "prosemirror-view";
import {prosemirrorToYDoc,ySyncPlugin} from "y-prosemirror";
import {richTextSchema as schema,PROSEMIRROR_FRAGMENT_KEY} from "./richTextSchema";
import {slashMenuPlugin,getSlashSession} from "./slashMenuPlugin";
function input(chunks:string[],initial="Existing content."){
 const doc=prosemirrorToYDoc(schema.node("doc",null,[schema.node("paragraph",null,initial?[schema.text(initial)]:[])]),PROSEMIRROR_FRAGMENT_KEY),sessions:unknown[]=[];
 const host=document.body.appendChild(document.createElement("div"));
 const view=new EditorView(host,{state:EditorState.create({schema,plugins:[ySyncPlugin(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_KEY)),slashMenuPlugin({onSessionChange:session=>sessions.push(session?{from:session.from,query:session.query}:null)})]}),dispatchTransaction(this:EditorView,tr){this.updateState(this.state.apply(tr));},handleScrollToSelection:()=>true});
 try{view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
 for(const chunk of chunks){const {from,to}=view.state.selection;const handled=view.someProp("handleTextInput",fn=>fn(view,from,to,chunk,()=>view.state.tr.insertText(chunk,from,to)));if(!handled)view.dispatch(view.state.tr.insertText(chunk));}
 return{text:view.state.doc.textContent,session:getSlashSession(view.state),sessions};
 }finally{view.destroy();doc.destroy();host.remove();}
}
it("keeps a slash query open through real Yjs dispatch while typing character by character",()=>{expect(input([..." /component"]).session?.query).toBe("component");});
it("opens a command when browser text input coalesces whitespace, slash and query",()=>{const result=input([" /component"]);expect(result.text).toBe("Existing content. /component");expect(result.session?.query).toBe("component");});
it("keeps URL slashes and a slash followed by whitespace as ordinary text",()=>{expect(input([" https://example.test/a"]).session).toBeNull();expect(input([" / "]).session).toBeNull();});
