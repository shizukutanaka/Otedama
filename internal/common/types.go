package common

import (
	"encoding/json"
	"fmt"
	"time"
)

// Result represents a generic result with value and error
type Result[T any] struct {
	Value T
	Error error
}

// NewResult creates a new Result
func NewResult[T any](value T, err error) Result[T] {
	return Result[T]{Value: value, Error: err}
}

// IsOk returns true if there's no error
func (r Result[T]) IsOk() bool {
	return r.Error == nil
}

// Unwrap returns the value or panics if there's an error
func (r Result[T]) Unwrap() T {
	if r.Error != nil {
		panic(r.Error)
	}
	return r.Value
}

// UnwrapOr returns the value or a default if there's an error
func (r Result[T]) UnwrapOr(defaultValue T) T {
	if r.Error != nil {
		return defaultValue
	}
	return r.Value
}

// Option represents an optional value
type Option[T any] struct {
	value *T
}

// Some creates an Option with a value
func Some[T any](value T) Option[T] {
	return Option[T]{value: &value}
}

// None creates an empty Option
func None[T any]() Option[T] {
	return Option[T]{value: nil}
}

// IsSome returns true if Option contains a value
func (o Option[T]) IsSome() bool {
	return o.value != nil
}

// IsNone returns true if Option is empty
func (o Option[T]) IsNone() bool {
	return o.value == nil
}

// Unwrap returns the value or panics if empty
func (o Option[T]) Unwrap() T {
	if o.value == nil {
		panic("called Unwrap on None value")
	}
	return *o.value
}

// UnwrapOr returns the value or a default if empty
func (o Option[T]) UnwrapOr(defaultValue T) T {
	if o.value == nil {
		return defaultValue
	}
	return *o.value
}

// Pair represents a pair of values
type Pair[T, U any] struct {
	First  T
	Second U
}

// NewPair creates a new Pair
func NewPair[T, U any](first T, second U) Pair[T, U] {
	return Pair[T, U]{First: first, Second: second}
}

// Triple represents three values
type Triple[T, U, V any] struct {
	First  T
	Second U
	Third  V
}

// NewTriple creates a new Triple
func NewTriple[T, U, V any](first T, second U, third V) Triple[T, U, V] {
	return Triple[T, U, V]{First: first, Second: second, Third: third}
}

// Set represents a set of unique values
type Set[T comparable] map[T]struct{}

// NewSet creates a new Set
func NewSet[T comparable](items ...T) Set[T] {
	s := make(Set[T])
	for _, item := range items {
		s.Add(item)
	}
	return s
}

// Add adds an item to the set
func (s Set[T]) Add(item T) {
	s[item] = struct{}{}
}

// Remove removes an item from the set
func (s Set[T]) Remove(item T) {
	delete(s, item)
}

// Contains checks if set contains an item
func (s Set[T]) Contains(item T) bool {
	_, exists := s[item]
	return exists
}

// Size returns the number of items in the set
func (s Set[T]) Size() int {
	return len(s)
}

// Clear removes all items from the set
func (s Set[T]) Clear() {
	for k := range s {
		delete(s, k)
	}
}

// ToSlice converts set to slice
func (s Set[T]) ToSlice() []T {
	slice := make([]T, 0, len(s))
	for item := range s {
		slice = append(slice, item)
	}
	return slice
}

// Queue represents a FIFO queue
type Queue[T any] struct {
	items []T
}

// NewQueue creates a new Queue
func NewQueue[T any]() *Queue[T] {
	return &Queue[T]{items: make([]T, 0)}
}

// Enqueue adds an item to the queue
func (q *Queue[T]) Enqueue(item T) {
	q.items = append(q.items, item)
}

// Dequeue removes and returns the first item
func (q *Queue[T]) Dequeue() (T, bool) {
	var zero T
	if len(q.items) == 0 {
		return zero, false
	}
	item := q.items[0]
	q.items = q.items[1:]
	return item, true
}

// Peek returns the first item without removing it
func (q *Queue[T]) Peek() (T, bool) {
	var zero T
	if len(q.items) == 0 {
		return zero, false
	}
	return q.items[0], true
}

// Size returns the number of items in the queue
func (q *Queue[T]) Size() int {
	return len(q.items)
}

// IsEmpty returns true if the queue is empty
func (q *Queue[T]) IsEmpty() bool {
	return len(q.items) == 0
}

// Stack represents a LIFO stack
type Stack[T any] struct {
	items []T
}

// NewStack creates a new Stack
func NewStack[T any]() *Stack[T] {
	return &Stack[T]{items: make([]T, 0)}
}

// Push adds an item to the stack
func (s *Stack[T]) Push(item T) {
	s.items = append(s.items, item)
}

// Pop removes and returns the top item
func (s *Stack[T]) Pop() (T, bool) {
	var zero T
	if len(s.items) == 0 {
		return zero, false
	}
	index := len(s.items) - 1
	item := s.items[index]
	s.items = s.items[:index]
	return item, true
}

// Peek returns the top item without removing it
func (s *Stack[T]) Peek() (T, bool) {
	var zero T
	if len(s.items) == 0 {
		return zero, false
	}
	return s.items[len(s.items)-1], true
}

// Size returns the number of items in the stack
func (s *Stack[T]) Size() int {
	return len(s.items)
}

// IsEmpty returns true if the stack is empty
func (s *Stack[T]) IsEmpty() bool {
	return len(s.items) == 0
}

// TimestampedValue represents a value with timestamp
type TimestampedValue[T any] struct {
	Value     T
	Timestamp time.Time
}

// NewTimestampedValue creates a new TimestampedValue
func NewTimestampedValue[T any](value T) TimestampedValue[T] {
	return TimestampedValue[T]{
		Value:     value,
		Timestamp: time.Now(),
	}
}

// Age returns the age of the value
func (tv TimestampedValue[T]) Age() time.Duration {
	return time.Since(tv.Timestamp)
}

// IsExpired checks if the value is older than the given duration
func (tv TimestampedValue[T]) IsExpired(ttl time.Duration) bool {
	return tv.Age() > ttl
}

// JSONTime represents time that can be marshaled to JSON
type JSONTime time.Time

// MarshalJSON marshals time to JSON
func (t JSONTime) MarshalJSON() ([]byte, error) {
	return json.Marshal(time.Time(t).Format(time.RFC3339))
}

// UnmarshalJSON unmarshals time from JSON
func (t *JSONTime) UnmarshalJSON(data []byte) error {
	var str string
	if err := json.Unmarshal(data, &str); err != nil {
		return err
	}
	parsed, err := time.Parse(time.RFC3339, str)
	if err != nil {
		return err
	}
	*t = JSONTime(parsed)
	return nil
}

// Time returns the underlying time.Time
func (t JSONTime) Time() time.Time {
	return time.Time(t)
}

// Bytes represents byte slice with helper methods
type Bytes []byte

// String returns hex string representation
func (b Bytes) String() string {
	return fmt.Sprintf("%x", []byte(b))
}

// Equal checks if two byte slices are equal
func (b Bytes) Equal(other Bytes) bool {
	if len(b) != len(other) {
		return false
	}
	for i := range b {
		if b[i] != other[i] {
			return false
		}
	}
	return true
}

// Copy returns a copy of the bytes
func (b Bytes) Copy() Bytes {
	c := make(Bytes, len(b))
	copy(c, b)
	return c
}

// Address represents a network address
type Address struct {
	Host string
	Port int
}

// NewAddress creates a new Address
func NewAddress(host string, port int) Address {
	return Address{Host: host, Port: port}
}

// String returns string representation of address
func (a Address) String() string {
	return fmt.Sprintf("%s:%d", a.Host, a.Port)
}

// IsValid checks if address is valid
func (a Address) IsValid() bool {
	return a.Host != "" && a.Port > 0 && a.Port <= 65535
}

// Duration wraps time.Duration with JSON support
type Duration time.Duration

// MarshalJSON marshals duration to JSON
func (d Duration) MarshalJSON() ([]byte, error) {
	return json.Marshal(time.Duration(d).String())
}

// UnmarshalJSON unmarshals duration from JSON
func (d *Duration) UnmarshalJSON(data []byte) error {
	var str string
	if err := json.Unmarshal(data, &str); err != nil {
		return err
	}
	parsed, err := time.ParseDuration(str)
	if err != nil {
		return err
	}
	*d = Duration(parsed)
	return nil
}

// Duration returns the underlying time.Duration
func (d Duration) Duration() time.Duration {
	return time.Duration(d)
}

// Percentage represents a percentage value (0-100)
type Percentage float64

// NewPercentage creates a new Percentage with validation
func NewPercentage(value float64) (Percentage, error) {
	if value < 0 || value > 100 {
		return 0, fmt.Errorf("percentage must be between 0 and 100, got %f", value)
	}
	return Percentage(value), nil
}

// Float64 returns the percentage as float64
func (p Percentage) Float64() float64 {
	return float64(p)
}

// String returns string representation
func (p Percentage) String() string {
	return fmt.Sprintf("%.2f%%", float64(p))
}