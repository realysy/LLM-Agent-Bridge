1. 创建一个C++ cmake project, 使用compile.sh编译并运行，遇到错误尝试修复直到成功
2. git管理这个项目，注意忽略build
3. 改进这个工程，创建一个接口库，让main链接它，并调用接口函数
4. IF agent not commit it autoly, say: commit it
5. 改进这个工程，将库封装为独立的cmake package, 然后在main所在package中通过find\_package查找链接

   IF agent not commit it autoly, say: git管理，注意忽略不必要的文件

English:

1. create a C++ cmake project, use compile.sh to compile and run, fix errors until success. answer in english.
2. git manage this project, ignore build
3. improve this project, create an interface library, let main link it, and call the interface function
4. commit it
5. improve this project, encapsulate the library as an independent cmake package, and then find\_package it in the main package to link it

   git manage, pay attention to ignore unnecessary files
