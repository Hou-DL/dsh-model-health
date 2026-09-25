export const Fragment = "Fragment";
export const createElement = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.length ? children.flat() : [],
});
export const useState = (init) => [typeof init === "function" ? init() : init, () => {}];
export const useEffect = () => {};
export const useMemo = (fn) => fn();
export const useCallback = (fn) => fn;
export const useRef = (init) => ({ current: init });
export default { Fragment, createElement, useState, useEffect, useMemo, useCallback, useRef };
