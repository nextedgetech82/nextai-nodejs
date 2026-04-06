import { Injectable } from "@angular/core";
import {
  HttpClient,
  HttpErrorResponse,
  HttpHeaders,
} from "@angular/common/http";
import { Observable, throwError, timeout, catchError, retry } from "rxjs";
import { environment } from "../environment/environment";
import { AnalyticsResponse } from "../models/analytics-response";
import { QueryRequest } from "../models/query-request";

@Injectable({
  providedIn: "root",
})
export class AnalyticsService {
  private apiUrl = environment.apiUrl;
  private timeout = environment.apiTimeout;

  constructor(private http: HttpClient) {}

  /**
   * Process natural language query
   */
  processQuery(
    query: string,
    skipCache: boolean = false,
  ): Observable<AnalyticsResponse> {
    const request: QueryRequest = { query, skipCache };

    return this.http
      .post<AnalyticsResponse>(`${this.apiUrl}/analytics`, request)
      .pipe(timeout(this.timeout), retry(1), catchError(this.handleError));
  }

  /**
   * Get predefined analytics
   */
  getPredefinedAnalytics(type: string): Observable<AnalyticsResponse> {
    return this.http
      .get<AnalyticsResponse>(`${this.apiUrl}/analytics/predefined/${type}`)
      .pipe(timeout(this.timeout), catchError(this.handleError));
  }

  /**
   * Get query suggestions
   */
  getSuggestions(): Observable<{ suggestions: string[] }> {
    return this.http
      .get<{ suggestions: string[] }>(`${this.apiUrl}/analytics/suggestions`)
      .pipe(timeout(5000), catchError(this.handleError));
  }

  /**
   * Get table list
   */
  getTables(): Observable<{ success: boolean; tables: string[] }> {
    return this.http
      .get<{
        success: boolean;
        tables: string[];
      }>(`${this.apiUrl}/metadata/tables`)
      .pipe(timeout(5000), catchError(this.handleError));
  }

  /**
   * Get table info
   */
  getTableInfo(tableName: string): Observable<any> {
    return this.http
      .get(`${this.apiUrl}/metadata/table/${tableName}`)
      .pipe(timeout(5000), catchError(this.handleError));
  }

  /**
   * Clear cache (admin only)
   */
  clearCache(pattern?: string): Observable<any> {
    return this.http
      .post(`${this.apiUrl}/admin/cache/clear`, { pattern })
      .pipe(timeout(10000), catchError(this.handleError));
  }

  /**
   * Get cache stats
   */
  getCacheStats(): Observable<any> {
    return this.http
      .get(`${this.apiUrl}/admin/cache/stats`)
      .pipe(timeout(5000), catchError(this.handleError));
  }

  /**
   * Error handler
   */
  private handleError(error: HttpErrorResponse) {
    let errorMessage = "An error occurred";

    if (error.error instanceof ErrorEvent) {
      // Client-side error
      errorMessage = error.error.message;
    } else {
      // Server-side error
      errorMessage = error.error?.error || error.message;
    }

    console.error("API Error:", error);
    return throwError(() => new Error(errorMessage));
  }
}
