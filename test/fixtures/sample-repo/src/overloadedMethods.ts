export class ApiClient {
  /**
   * Doc line 0 for get overload 1 -- explains the simple string-url form.
   * Doc line 1 for get overload 1 -- explains the simple string-url form.
   * Doc line 2 for get overload 1 -- explains the simple string-url form.
   * Doc line 3 for get overload 1 -- explains the simple string-url form.
   * Doc line 4 for get overload 1 -- explains the simple string-url form.
   * Doc line 5 for get overload 1 -- explains the simple string-url form.
   */
  get(url: string): Observable<Object>;

  /**
   * Doc line 0 for get overload 2 -- explains the options-object form.
   * Doc line 1 for get overload 2 -- explains the options-object form.
   * Doc line 2 for get overload 2 -- explains the options-object form.
   * Doc line 3 for get overload 2 -- explains the options-object form.
   * Doc line 4 for get overload 2 -- explains the options-object form.
   * Doc line 5 for get overload 2 -- explains the options-object form.
   */
  get(url: string, options: { headers?: any }): Observable<Object>;

  get(url: string, options?: any): Observable<any> {
    return this.request('GET', url, options);
  }

  /**
   * Doc line 0 for post overload 1 -- explains the simple string-url form.
   * Doc line 1 for post overload 1 -- explains the simple string-url form.
   * Doc line 2 for post overload 1 -- explains the simple string-url form.
   * Doc line 3 for post overload 1 -- explains the simple string-url form.
   * Doc line 4 for post overload 1 -- explains the simple string-url form.
   * Doc line 5 for post overload 1 -- explains the simple string-url form.
   */
  post(url: string): Observable<Object>;

  /**
   * Doc line 0 for post overload 2 -- explains the options-object form.
   * Doc line 1 for post overload 2 -- explains the options-object form.
   * Doc line 2 for post overload 2 -- explains the options-object form.
   * Doc line 3 for post overload 2 -- explains the options-object form.
   * Doc line 4 for post overload 2 -- explains the options-object form.
   * Doc line 5 for post overload 2 -- explains the options-object form.
   */
  post(url: string, options: { headers?: any }): Observable<Object>;

  post(url: string, options?: any): Observable<any> {
    return this.request('POST', url, options);
  }

  /**
   * Doc line 0 for put overload 1 -- explains the simple string-url form.
   * Doc line 1 for put overload 1 -- explains the simple string-url form.
   * Doc line 2 for put overload 1 -- explains the simple string-url form.
   * Doc line 3 for put overload 1 -- explains the simple string-url form.
   * Doc line 4 for put overload 1 -- explains the simple string-url form.
   * Doc line 5 for put overload 1 -- explains the simple string-url form.
   */
  put(url: string): Observable<Object>;

  /**
   * Doc line 0 for put overload 2 -- explains the options-object form.
   * Doc line 1 for put overload 2 -- explains the options-object form.
   * Doc line 2 for put overload 2 -- explains the options-object form.
   * Doc line 3 for put overload 2 -- explains the options-object form.
   * Doc line 4 for put overload 2 -- explains the options-object form.
   * Doc line 5 for put overload 2 -- explains the options-object form.
   */
  put(url: string, options: { headers?: any }): Observable<Object>;

  put(url: string, options?: any): Observable<any> {
    return this.request('PUT', url, options);
  }

  /**
   * Doc line 0 for remove overload 1 -- explains the simple string-url form.
   * Doc line 1 for remove overload 1 -- explains the simple string-url form.
   * Doc line 2 for remove overload 1 -- explains the simple string-url form.
   * Doc line 3 for remove overload 1 -- explains the simple string-url form.
   * Doc line 4 for remove overload 1 -- explains the simple string-url form.
   * Doc line 5 for remove overload 1 -- explains the simple string-url form.
   */
  remove(url: string): Observable<Object>;

  /**
   * Doc line 0 for remove overload 2 -- explains the options-object form.
   * Doc line 1 for remove overload 2 -- explains the options-object form.
   * Doc line 2 for remove overload 2 -- explains the options-object form.
   * Doc line 3 for remove overload 2 -- explains the options-object form.
   * Doc line 4 for remove overload 2 -- explains the options-object form.
   * Doc line 5 for remove overload 2 -- explains the options-object form.
   */
  remove(url: string, options: { headers?: any }): Observable<Object>;

  remove(url: string, options?: any): Observable<any> {
    return this.request('REMOVE', url, options);
  }

}

