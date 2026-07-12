package intro

import (
	"fmt"
	"strings"
	"time"
)

// User is the subset of a github_users row needed to build an introduction.
// Optional columns are pointers so a NULL is distinguishable from an empty
// string or a zero count.
type User struct {
	Username      string
	Name          *string
	Bio           *string
	Company       *string
	Location      *string
	PublicRepos   int
	Followers     int
	GitHubCreated *time.Time
}

// Build renders a Chinese self-introduction. Optional fields that are nil are
// dropped whole, never rendered as an empty or "<nil>" fragment.
func Build(u User) string {
	display := u.Username
	if u.Name != nil && strings.TrimSpace(*u.Name) != "" {
		display = *u.Name
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%s（@%s）", display, u.Username)

	if u.Location != nil && strings.TrimSpace(*u.Location) != "" {
		fmt.Fprintf(&b, "来自 %s", *u.Location)
	}
	if u.Company != nil && strings.TrimSpace(*u.Company) != "" {
		fmt.Fprintf(&b, "，就职于 %s", *u.Company)
	}

	fmt.Fprintf(&b, "。目前有 %d 个公开仓库，%d 位关注者。", u.PublicRepos, u.Followers)

	if u.GitHubCreated != nil {
		fmt.Fprintf(&b, "GitHub 账号注册于 %d 年。", u.GitHubCreated.Year())
	}
	if u.Bio != nil && strings.TrimSpace(*u.Bio) != "" {
		fmt.Fprintf(&b, "个人简介：%s", strings.TrimSpace(*u.Bio))
	}

	return b.String()
}
