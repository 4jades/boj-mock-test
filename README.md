# boj-mock-test

백준(BOJ) 문제로 코딩테스트를 “모의시험”처럼 볼 수 있게 해주는 VS Code 확장입니다.  
원하는 언어를 선택하고, 문제를 랜덤으로 뽑거나(난이도 범위 포함) 문제 번호를 직접 입력해 세션을 만들 수 있습니다. 세션이 시작되면 문제 본문(문제/입력/출력/예제)을 VS Code 안에서 보고, 예제 입력으로 로컬 실행 결과를 바로 확인할 수 있습니다.

## 주요 기능

### 1) 모의 테스트 세션 생성
명령 팔레트에서 아래 명령으로 세션을 시작합니다.

- `BOJ: Pick Random Problems` (`boj-mock-test.pick3`)

세션 시작 흐름
1. 풀이 언어 선택: Python, JavaScript, Kotlin, Java, C++, C
2. 모드 선택
   - 랜덤 문제: solved.ac 조건으로 문제 후보를 가져와 랜덤 추첨
   - 문제 번호 직접 입력: 원하는 문제 번호를 입력해 세션 구성
3. 문제 개수 입력 (최대 10)
4. (랜덤 모드) 백준 ID 입력 후, 난이도 범위 선택 또는 직접 입력
5. 시험 시간(분) 입력

### 2) 랜덤 모드 비공개 처리
랜덤 모드에서는 시험처럼 사용할 수 있도록 다음이 숨겨집니다.
- 문제 번호, 제목
- “원문 열기” 버튼 비활성화

### 3) 문제 본문/예제 표시 UI
세션 패널에서 다음을 제공합니다.
- 좌측: 문제 목록, 남은 시간, 시험 종료 버튼
- 우측: 문제(설명), 입력, 출력, 예제(일부 미리보기), 실행 결과

### 4) 예제 실행 및 채점(PASS/FAIL)
- `전체 예제 Run`: 모든 예제 입력을 실행해 PASS/FAIL을 표시
- `예제 Run`: 선택한 예제 1개만 실행해 PASS/FAIL 표시
- 실행 결과는 ⭕/❌ 배지로 표시되며, 오답일 때 기대/출력을 함께 보여줍니다.

참고
- 실행은 로컬에서 언어별 런타임/컴파일러를 호출해 수행합니다.
- 기본 타임아웃은 예제당 2000ms 입니다.

### 5) 시험 종료(제출/결과 링크 제공 + 저장 폴더 오픈)
시험 종료 버튼을 누르면
- 타이머가 멈춥니다.
- 각 문제에 대해 아래 링크를 제공합니다.
  - 제출하기
  - 채점/결과 확인
  - 문제 보기
- 해당 세션의 코드 저장 폴더를 OS 파일 탐색기로 엽니다.

### 6) 손코딩 모드(IDE 자동완성 등 끄기/켜기)
- `BOJ: 손코딩 모드 ON/OFF` (`boj-mock-test.toggleHandCoding`)

손코딩 모드 ON 시(전역 설정 변경)
- 자동완성/추천/인라인 제안
- 트리거 문자 제안
- 파라미터 힌트
- 호버
- 라이트벌브
- (TS/JS) auto import 제안

손코딩 모드 OFF 시 원래대로 되돌립니다.

## 사용 방법

1. VS Code에서 확장 설치
2. 사이드바에 `boj-mock-test` 뷰가 보입니다.
   - “모의테스트 시작” 버튼으로도 시작할 수 있습니다.
3. 또는 명령 팔레트에서 실행
   - `BOJ: Pick Random Problems`

세션 중 사용
- 좌측에서 문제를 클릭하면 코드 파일이 열리고(에디터 오른쪽 컬럼), 문제 내용이 패널에 표시됩니다.
- `전체 예제 Run` 또는 `예제 Run`으로 예제를 실행합니다.
- 시험 종료 시 제출/결과 링크로 이동합니다.

## 지원 언어 및 실행 방식

- Python: `python3 main.py`
- JavaScript: `node main.js`
- Kotlin: `kotlinc Main.kt -include-runtime -d main.jar` 후 `java -jar main.jar`
- Java: `javac Main.java` 후 `java -cp <dir> Main`
- C++: `g++ main.cpp -std=c++17 -O2 ...` 후 실행 파일 실행
- C: `gcc main.c -std=c11 -O2 ...` 후 실행 파일 실행

## 코드 저장 위치

세션이 시작되면 아래 경로에 코드가 저장됩니다.

- 워크스페이스가 열려 있으면: `<workspace>/.boj-mock-test/runs/<세션ID>/...`
- 워크스페이스가 없으면: 확장의 globalStorage 경로 아래

폴더 구성
- 수동 모드(문제 번호 입력): `<problemId>_<title>_<lang>/main.*`
- 랜덤 모드: `random_<index>_<random>/main.*`

## Requirements

로컬 실행을 위해 사용하는 언어의 실행 환경이 설치되어 있어야 합니다.

- Python: `python3`
- Node.js: `node`
- Kotlin: `kotlinc`, `java`
- Java: `javac`, `java`
- C++: `g++`
- C: `gcc`

추가로 네트워크가 필요합니다.
- solved.ac API 호출(랜덤 모드)
- 백준 문제 페이지 로딩/파싱

## Extension Settings

이 확장은 VS Code 설정을 직접 제공합니다(contributes.configuration)는 없지만,
손코딩 모드 토글 시 아래 전역 설정 값을 변경합니다.

- `editor.quickSuggestions`
- `editor.suggestOnTriggerCharacters`
- `editor.wordBasedSuggestions`
- `editor.parameterHints.enabled`
- `editor.hover.enabled`
- `editor.lightbulb.enabled`
- `editor.acceptSuggestionOnEnter`
- `editor.tabCompletion`
- `editor.inlineSuggest.enabled`
- `typescript.suggest.autoImports`
- `javascript.suggest.autoImports`

손코딩 모드를 OFF로 되돌리면 원래 값으로 복구합니다.

## Known Issues

- 일부 문제는 백준 페이지 구조 변경/차단 등으로 파싱이 실패할 수 있습니다.
- 로컬에 컴파일러/런타임이 없으면 실행/컴파일 단계에서 실패합니다.
- 예제 시간 제한은 현재 고정(2000ms)이라, 오래 걸리는 문제는 로컬 실행이 시간 초과로 처리될 수 있습니다.
- 랜덤 모드에서는 의도적으로 원문 열기/문제 메타가 숨겨집니다.

## Release Notes

### 0.0.1
- 모의 테스트 세션 생성(랜덤/수동)
- 문제 본문(문제/입력/출력/예제) 표시
- 예제 실행 및 PASS/FAIL 표시
- 시험 종료(제출/결과 링크 제공, 코드 폴더 오픈)
- 손코딩 모드 ON/OFF

## 명령(Command)

- `boj-mock-test.pick3` : 세션 시작
- `boj-mock-test.toggleHandCoding` : 손코딩 모드 토글
