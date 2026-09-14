export const state = {
  page:'files',
  dir:'',
  files:[],
  viewMode:'list',
  selectedPaths:new Set(),
  repoInfo:null,
  currentFile:null,
  contextFile:null,
  contextIsDirectory:false,
  nextCursor:null,
};
