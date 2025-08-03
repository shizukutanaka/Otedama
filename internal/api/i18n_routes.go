package api

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/shizukutanaka/Otedama/internal/i18n"
	"go.uber.org/zap"
)

// RegisterI18nRoutes registers internationalization API routes
func (s *Server) RegisterI18nRoutes(router *mux.Router) {
	i18n := router.PathPrefix("/i18n").Subrouter()
	
	// Get supported languages
	i18n.HandleFunc("/languages", s.handleGetLanguages).Methods("GET")
	
	// Get current language
	i18n.HandleFunc("/current", s.handleGetCurrentLanguage).Methods("GET")
	
	// Set language
	i18n.HandleFunc("/language", s.handleSetLanguage).Methods("PUT")
	
	// Get translations for a language
	i18n.HandleFunc("/translations/{lang}", s.handleGetTranslations).Methods("GET")
	
	// Translate a key
	i18n.HandleFunc("/translate", s.handleTranslate).Methods("POST")
}

// handleGetLanguages returns supported languages
func (s *Server) handleGetLanguages(w http.ResponseWriter, r *http.Request) {
	languages := i18n.GetLanguageInfo()
	
	// Filter by actually supported languages if manager is available
	manager := i18n.GetGlobalManager()
	if manager != nil {
		supported := manager.GetSupportedLanguages()
		var filteredLangs []i18n.LanguageInfo
		for _, lang := range languages {
			for _, sup := range supported {
				if lang.Code == sup {
					filteredLangs = append(filteredLangs, lang)
					break
				}
			}
		}
		languages = filteredLangs
	}
	
	s.writeJSON(w, http.StatusOK, map[string]interface{}{
		"languages": languages,
		"count":     len(languages),
	})
}

// handleGetCurrentLanguage returns the current language
func (s *Server) handleGetCurrentLanguage(w http.ResponseWriter, r *http.Request) {
	// Get language from context or request
	lang := i18n.DetectLanguage(r)
	
	// Find language info
	var langInfo *i18n.LanguageInfo
	for _, info := range i18n.GetLanguageInfo() {
		if info.Code == lang {
			langInfo = &info
			break
		}
	}
	
	response := map[string]interface{}{
		"language": lang,
	}
	
	if langInfo != nil {
		response["info"] = langInfo
	}
	
	s.writeJSON(w, http.StatusOK, response)
}

// SetLanguageRequest represents language change request
type SetLanguageRequest struct {
	Language string `json:"language"`
}

// handleSetLanguage sets the user's language preference
func (s *Server) handleSetLanguage(w http.ResponseWriter, r *http.Request) {
	var req SetLanguageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	// Validate language
	manager := i18n.GetGlobalManager()
	if manager != nil && !manager.HasLanguage(req.Language) {
		s.writeError(w, http.StatusBadRequest, "Unsupported language")
		return
	}
	
	// Set cookie
	http.SetCookie(w, &http.Cookie{
		Name:     "language",
		Value:    req.Language,
		Path:     "/",
		MaxAge:   86400 * 365, // 1 year
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	
	s.logger.Info("Language preference updated",
		zap.String("language", req.Language))
	
	s.writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"language": req.Language,
		"message":  i18n.Translate(req.Language, "message.settings_saved"),
	})
}

// handleGetTranslations returns all translations for a language
func (s *Server) handleGetTranslations(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	lang := vars["lang"]
	
	manager := i18n.GetGlobalManager()
	if manager == nil {
		s.writeError(w, http.StatusServiceUnavailable, "I18n not initialized")
		return
	}
	
	if !manager.HasLanguage(lang) {
		s.writeError(w, http.StatusNotFound, "Language not found")
		return
	}
	
	translations := manager.GetTranslations(lang)
	
	s.writeJSON(w, http.StatusOK, map[string]interface{}{
		"language":     lang,
		"translations": translations,
		"count":        len(translations),
	})
}

// TranslateRequest represents translation request
type TranslateRequest struct {
	Key      string        `json:"key"`
	Language string        `json:"language,omitempty"`
	Args     []interface{} `json:"args,omitempty"`
}

// handleTranslate translates a key
func (s *Server) handleTranslate(w http.ResponseWriter, r *http.Request) {
	var req TranslateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	if req.Key == "" {
		s.writeError(w, http.StatusBadRequest, "Missing translation key")
		return
	}
	
	// Use language from request, context, or default
	lang := req.Language
	if lang == "" {
		lang = i18n.LanguageFromContext(r.Context())
	}
	
	// Translate
	var translation string
	if len(req.Args) > 0 {
		translation = i18n.Translate(lang, req.Key, req.Args...)
	} else {
		translation = i18n.Translate(lang, req.Key)
	}
	
	s.writeJSON(w, http.StatusOK, map[string]interface{}{
		"key":         req.Key,
		"language":    lang,
		"translation": translation,
	})
}

// TranslateBulkRequest represents bulk translation request
type TranslateBulkRequest struct {
	Keys     []string `json:"keys"`
	Language string   `json:"language,omitempty"`
}

// handleTranslateBulk translates multiple keys
func (s *Server) handleTranslateBulk(w http.ResponseWriter, r *http.Request) {
	var req TranslateBulkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	if len(req.Keys) == 0 {
		s.writeError(w, http.StatusBadRequest, "No translation keys provided")
		return
	}
	
	// Use language from request, context, or default
	lang := req.Language
	if lang == "" {
		lang = i18n.LanguageFromContext(r.Context())
	}
	
	// Translate all keys
	translations := make(map[string]string)
	for _, key := range req.Keys {
		translations[key] = i18n.Translate(lang, key)
	}
	
	s.writeJSON(w, http.StatusOK, map[string]interface{}{
		"language":     lang,
		"translations": translations,
		"count":        len(translations),
	})
}